// Closed Devnet failure receipts, all signatures/RPC are disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {failureKey,failureRecord} from '../orders/failure-record.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {replacementKey} from '../orders/replacement.mjs';
import {validateBuyerResult} from '../orders/submission.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://failure-recovery.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
function harness(){
  f.setGeneration(1);f.setMode('normal');const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-failure:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-failure:')&&!saved.has(k))){fault=null;throw Error('lost commit reply');}return result;
  }};
  const create=(secret='fixture-secret-42')=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:secret},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const c=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const b=await r.json();rewrite(c,b);return Response.json(b);}});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  const prepare=async input=>{const order=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
    await report(await call('prepare',{order}));const quote=(await report(await call('check',f.input(input.order.id)))).costQuote;
    return{version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};};
  return{values,call,prepare,restart:secret=>{gate=create(secret);},fault:v=>fault=v,rewrite:v=>rewrite=v};
}
test('finalized exact failure and charged fee persist before response; original claims and bytes stay closed after restart',async()=>{
  const h=harness(),input=f.signedInput('failure-linked'),cost=await h.prepare(input);
  assert.equal((await report(await h.call('send',input,{costApproval:cost}))).status,'accepted');const original=structuredClone(h.values);
  // Status RPC context may lead the finalized bank; the account floor is the finalized transaction slot.
  h.rewrite((c,b)=>{if(c.method==='getSignatureStatuses')b.result.context.slot=1000;});
  f.setMode('failure-finalized');const before=f.calls.length,failed=await report(await h.call('recover',input));
  assert.equal(failed.status,'failed');assert.equal(failed.retryAuthorized,false);assert.equal(failed.evidence.feeLamports,'10000');
  assert.equal(failed.evidence.payerDebitLamports,'10000');assert.equal(failed.proof.executionFailed,true);validateBuyerResult(failed,input,{recovery:true});
  assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getSignatureStatuses','getTransaction','getMultipleAccounts','getSignatureStatuses']);
  assert.equal(f.calls.slice(before).find(c=>c.method==='getMultipleAccounts').params[1].minContextSlot,650);
  assert.equal(failed.proof.accountSlot,700);assert.equal(failed.evidence.statusSlot,1000);
  assert.deepEqual(h.values.get(failureKey(input.order)),failureRecord(input,failed));
  for(const [key,value]of original)if(key!=='buyer-check-budget:v1')assert.deepEqual(h.values.get(key),value);
  h.restart('rotated-secret-42');const calls=f.calls.length,paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:3})};
  const restored=await report(await h.call('recover',paused));assert.equal(restored.restored,true);assert.equal(restored.orderRevision,4);
  assert.deepEqual(restored.evidence,failed.evidence);assert.deepEqual(restored.proof,failed.proof);assert.equal(f.calls.length,calls);
  for(const [route,value,extra]of [['send',input,{costApproval:cost}],['check',f.input(input.order.id),{}],['review-expiry',input,{authorizeExpiryReview:true}]]){
    const r=await h.call(route,value,extra);assert.equal(r.status,409);assert.equal((await r.json()).code,'ATTEMPT_FAILED');}
  assert.equal(f.calls.length,calls);assert.equal(closeAttempt(f,input,failed).order.items[0].attempts[0].state,'failed');
});
test('failed signature observed outside this gateway closes a saved unsent attempt without inventing anchor, approval or send claim',async()=>{
  const h=harness(),input=f.signedInput('failure-unsent');f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');
  assert.equal((await report(await h.call('recover',input))).status,'failed');
  assert.equal([...h.values.keys()].some(k=>k.startsWith('buyer-send:')||k.startsWith('buyer-blockhash:')),false);
  const fresh=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)}),calls=f.calls.length;
  assert.equal((await h.call('prepare',{order:fresh})).status,409);assert.equal((await h.call('send',input,{costApproval:{}})).status,409);
  assert.equal(f.calls.length,calls);
});
test('pending/error-only/missing fee/observed asset/bot-tax-like success remain unknown and cannot become failure evidence',async()=>{
  for(const mode of ['failure-pending','failure-asset','failure-no-fee','failed','absent-asset','missing']){
    const h=harness(),input=f.signedInput('failure-mode-'+mode);f.receipt(input.response.transactionBase64);f.setMode(mode);
    const result=await report(await h.call('recover',input));assert.equal(result.status,'unknown',mode);assert.equal(result.proof,undefined);
    assert.equal(h.values.has(failureKey(input.order)),false);
  }
});
test('mismatched bytes/status/error, unsafe fee/balances and changed final reread never retire a failure',async()=>{
  const edits=[
    (c,b)=>{if(c.method==='getTransaction')b.result.transaction[0]='AAAA';},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.err={InstructionError:[0,{Custom:2}]};},
    (c,b)=>{if(c.method==='getTransaction')b.result.version=1;},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.postBalances[0]--;},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.postBalances[2]++;},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.fee=Number.MAX_SAFE_INTEGER+1;},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.preBalances.pop();},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=649;},
    (c,b)=>{if(c.method==='getSignatureStatuses')b.result.value[0].status={Ok:null};},
  ];
  for(const [n,edit]of edits.entries()){
    const h=harness(),input=f.signedInput('failure-edit-'+n);f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');h.rewrite(edit);
    assert.equal((await report(await h.call('recover',input))).status,'unknown');assert.equal(h.values.has(failureKey(input.order)),false);
  }
  const h=harness(),input=f.signedInput('failure-final-reread');f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');let statuses=0;
  h.rewrite((c,b)=>{if(c.method==='getSignatureStatuses'&&++statuses===2)b.result.value[0].err=null;});
  assert.equal((await report(await h.call('recover',input))).status,'unknown');assert.equal(statuses,2);assert.equal(h.values.has(failureKey(input.order)),false);
});
test('failed/dropped durable writes report no terminal success; lost committed reply restores without RPC despite hold',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),input=f.signedInput('failure-storage-'+fault);f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');h.fault(fault);
    const response=await h.call('recover',input);assert.equal(response.status,503);assert.equal((await response.json()).report,undefined);
    assert.equal(h.values.has(failureKey(input.order)),fault==='ack');
    if(fault==='ack'){const before=f.calls.length;h.restart('rotated-secret-42');assert.equal((await report(await h.call('recover',input))).restored,true);assert.equal(f.calls.length,before);}
  }
});
test('corrupt or contradictory retained terminal evidence blocks restore and never releases old bytes',async()=>{
  const h=harness(),input=f.signedInput('failure-corrupt');f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');await report(await h.call('recover',input));
  const key=failureKey(input.order),record=structuredClone(h.values.get(key)),before=f.calls.length;
  h.values.get(key).evidence.feeLamports='999';assert.equal((await h.call('recover',input)).status,409);
  h.values.set(key,record);h.values.set(expiryKey(input.order),{});const conflict=await h.call('recover',input);
  assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'TERMINAL_RECORD_CONFLICT');assert.equal(f.calls.length,before);
});
test('second attempt failure retains first expiry/replacement and cannot reopen either attempt',async()=>{
  const h=harness(),first=f.signedInput('failure-second');await h.prepare(first);f.setMode('expiry-clear');
  const expiry=await report(await h.call('review-expiry',first,{authorizeExpiryReview:true})),source=closeAttempt(f,first,expiry);
  f.setGeneration(2);f.setMode('normal');const replacement=await report(await h.call('replace',source,{authorizeReplacement:true}));
  const second=signReplacement(f,replacementPartial(f,source,replacement));f.receipt(second.response.transactionBase64);f.setMode('failure-finalized');
  const oldExpiry=structuredClone(h.values.get(expiryKey(first.order))),oldReplacement=structuredClone(h.values.get(replacementKey(first.order)));
  const result=await report(await h.call('recover',second));assert.equal(result.status,'failed');assert.equal(result.proof.slot,1450);
  assert.deepEqual(h.values.get(expiryKey(first.order)),oldExpiry);assert.deepEqual(h.values.get(replacementKey(first.order)),oldReplacement);
  assert.equal(h.values.has(failureKey(second.order,2)),true);assert.equal(h.values.has(failureKey(second.order)),false);
  h.restart();const before=f.calls.length;assert.equal((await report(await h.call('recover',second))).restored,true);
  assert.equal((await h.call('send',second,{costApproval:{}})).status,409);
  assert.equal((await h.call('replace',closeAttempt(f,second,result),{authorizeReplacement:true})).status,400);assert.equal(f.calls.length,before);
});
test('transport binds fee/proof identity and sender recovers a lost local commit without network, wallet or send repetition',async()=>{
  const h=harness(),input=f.signedInput('failure-transport');f.receipt(input.response.transactionBase64);f.setMode('failure-finalized');const result=await report(await h.call('recover',input));
  for(const edit of [r=>r.signature='wrong',r=>r.evidence.feeLamports='1',r=>r.evidence.statusSlot=0,
    r=>r.evidence.errorSha256=[r.evidence.errorSha256],r=>r.retryAuthorized=true,r=>r.proof.accountAbsent=false]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,init)=>{const request=JSON.parse(init.body),r=structuredClone(result);edit(r);return Response.json({version:1,nonce:request.nonce,report:r});}});
    await assert.rejects(transport.recover(input));
  }
  let calls=0,saves=0,state={status:'ready',input};const sender=createBuyerSender({scope:{},storage:{readBuyerSubmission:async()=>state,saveBuyerFailure:async()=>{
    saves++;state={status:'failed',input:closeAttempt(f,input,result),failureRecord:failureRecord(input,result)};throw Error('LOST_FAILURE_ACK');}},
    transport:{send:()=>assert.fail('send'),recover:async()=>{calls++;return result;}}});
  await assert.rejects(sender.recover(),/LOST_FAILURE_ACK/);const restored=await sender.recover();assert.equal(restored.status,'already-recorded');assert.equal(restored.outcome,'failed');
  assert.equal(restored.feeLamports,'10000');assert.equal(restored.retryAuthorized,false);assert.equal(calls,1);assert.equal(saves,1);
  await assert.rejects(sender.sendOnce({authorizeDevnetSend:true}),/PERSISTENT_STORAGE_REQUIRED|SEND_NOT_READY/);
  await assert.rejects(sender.prepareReplacement({authorizeReplacement:true}),/PAID_FEE_ACKNOWLEDGMENT_REQUIRED/);
  await assert.rejects(sender.reviewExpiry({authorizeExpiryReview:true}),/EXPIRY_NOT_READY/);
});
