// Closed Devnet failure receipts, all signatures/RPC are disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {failureKey,failureRecord} from '../orders/failure-record.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://response-recovery.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
function harness(){
  f.setGeneration(1);f.setMode('normal');const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-response-recovery:')||k.startsWith('buyer-failure:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-response-recovery:')&&!saved.has(k))){fault=null;throw Error('lost commit reply');}return result;
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
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {responseRecoveryKey,validateResponseRecovery} from '../orders/response-recovery.mjs';
import {createBuyerResponseRecovery} from '../orders/response-recovery-client.mjs';
test('positive finalized discovery retains exact response and outcome before reply, cached restore and old sends remain closed',async()=>{
  const h=harness(),full=f.signedInput('response-positive'),approval=await h.prepare(full),input=missingResponse(full,approval);
  f.receipt(full.response.transactionBase64);const before=f.calls.length;
  const found=await report(await h.call('recover-response',input));validateResponseRecovery(found,input);
  assert.equal(found.status,'response-recovered');assert.equal(found.result.status,'verified');assert.deepEqual(found.response,full.response);
  assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getSignaturesForAddress','getTransaction','getGenesisHash','getSignatureStatuses','getTransaction','getMultipleAccounts']);
  assert.deepEqual(f.calls[before+1].params,[input.claim.asset,{commitment:'finalized',limit:10,minContextSlot:600}]);
  assert.equal([...h.values.keys()].some(k=>k.startsWith('buyer-send:')),false);
  h.restart('rotated-secret-42');const count=f.calls.length;
  const paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:2})};
  const restored=await report(await h.call('recover-response',paused));assert.equal(restored.restored,true);assert.equal(restored.orderRevision,3);
  assert.equal((await report(await h.call('recover',full))).restored,true);
  for(const [route,value,extra]of [['send',full,{costApproval:approval}],['check',f.input(full.order.id),{}],['review-expiry',full,{authorizeExpiryReview:true}]]){
    assert.equal((await h.call(route,value,extra)).status,409);
  }
  assert.equal(f.calls.length,count);assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
test('failed discovery atomically retains charged fee and permits only the separate acknowledged replacement flow',async()=>{
  const h=harness(),full=f.signedInput('response-failed');await h.prepare(full);const input=missingResponse(full);
  f.receipt(full.response.transactionBase64);f.setMode('failure-finalized');const found=await report(await h.call('recover-response',input));
  assert.equal(found.result.status,'failed');assert.equal(found.result.evidence.feeLamports,'10000');
  assert.deepEqual(h.values.get(failureKey(full.order)),failureRecord(full,found.result));
  h.restart('rotated-secret-42');const count=f.calls.length;
  assert.equal((await report(await h.call('recover-response',input))).restored,true);assert.equal((await report(await h.call('recover',full))).status,'failed');assert.equal(f.calls.length,count);
  h.restart();f.setGeneration(2);f.setMode('normal');const source=closeAttempt(f,full,found.result);
  assert.equal((await h.call('replace',source,{authorizeReplacement:true})).status,400);
  const replacement=await report(await h.call('replace',source,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  const second=signReplacement(f,replacementPartial(f,source,replacement)),missing=missingResponse(second);
  f.receipt(second.response.transactionBase64);const secondFound=await report(await h.call('recover-response',missing));
  assert.equal(secondFound.result.status,'verified');assert.equal(secondFound.result.proof.slot,1450);
  assert.equal(h.values.has(responseRecoveryKey(full.order)),true);assert.equal(h.values.has(responseRecoveryKey(second.order,2)),true);
  h.restart('rotated-secret-42');assert.equal((await report(await h.call('recover-response',missing))).restored,true);
  assert.equal((await h.call('send',second,{costApproval:{}})).status,409);
});
test('empty, truncated, contradictory, stale and nonfinalized histories retain unknown without returning bytes or granting retry',async()=>{
  const edits=[
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result=[];},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result=Array(10).fill(b.result[0]);},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result.push(b.result[0]);},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].slot=599;},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].confirmationStatus='confirmed';},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].err={InstructionError:[0,{Custom:1}]};},
    (c,b)=>{if(c.method==='getTransaction')b.result=null;},
    (c,b)=>{if(c.method==='getTransaction')b.result.transaction[0]='AAAA';},
    (c,b)=>{if(c.method==='getTransaction')b.result.version=1;},
    (c,b)=>{if(c.method==='getMultipleAccounts'&&c.params[0].length===1)b.result.value=[null];},
  ];
  for(const [n,edit]of edits.entries()){
    const h=harness(),full=f.signedInput('response-negative-'+n);await h.prepare(full);f.receipt(full.response.transactionBase64);h.rewrite(edit);
    const input=missingResponse(full),result=await report(await h.call('recover-response',input));
    assert.equal(result.status,'unknown',String(n));assert.equal(result.response,undefined);assert.equal(result.result,undefined);assert.equal(result.retryAuthorized,false);
    assert.equal(h.values.has(responseRecoveryKey(full.order)),false);
  }
});
test('missing anchor, malformed native request, absent wallet claim and a saved buyer response fail before discovery',async()=>{
  const h=harness(),full=f.signedInput('response-binding'),input=missingResponse(full),before=f.calls.length;
  assert.equal((await h.call('recover-response',input)).status,409);assert.equal(f.calls.length,before);await h.prepare(full);
  for(const edit of [v=>delete v.walletClaim,v=>v.walletClaim.orderRevision++,v=>v.walletClaim.requestId='0'.repeat(64),
    v=>v.request.transactionBase64='AAAA',v=>v.order=full.order,v=>v.response=full.response]){
    const changed=structuredClone(input);edit(changed);const count=f.calls.length;
    assert.equal((await h.call('recover-response',changed)).status,400);assert.equal(f.calls.length,count);
  }
});
test('rollback on response/fee write failure and cached restore after lost commit acknowledgment',async()=>{
  for(const mode of ['normal','failure-finalized'])for(const fault of ['write','drop','ack']){
    const h=harness(),full=f.signedInput('response-storage-'+mode+'-'+fault);await h.prepare(full);const input=missingResponse(full);
    f.receipt(full.response.transactionBase64);f.setMode(mode);h.fault(fault);const r=await h.call('recover-response',input);
    assert.equal(r.status,503);assert.equal((await r.json()).report,undefined);
    assert.equal(h.values.has(responseRecoveryKey(full.order)),fault==='ack');assert.equal(h.values.has(failureKey(full.order)),fault==='ack'&&mode==='failure-finalized');
    if(fault==='ack'){
      h.restart('rotated-secret-42');const before=f.calls.length;
      assert.equal((await report(await h.call('recover-response',input))).restored,true);assert.equal(f.calls.length,before);
      assert.equal((await h.call('send',full,{costApproval:{}})).status,409);
    }
  }
});
test('corrupt retained identity/proof, another wallet claim and contradictory terminal evidence never restore',async()=>{
  const h=harness(),full=f.signedInput('response-corrupt');await h.prepare(full);f.receipt(full.response.transactionBase64);const input=missingResponse(full);
  await report(await h.call('recover-response',input));const key=responseRecoveryKey(full.order),original=structuredClone(h.values.get(key)),count=f.calls.length;
  for(const edit of [v=>v.identity.requestId='0'.repeat(64),v=>v.proof.account.owner=f.key('stranger').publicKey.toBase58(),v=>v.response.transactionBase64='AAAA']){
    const changed=structuredClone(original);edit(changed);h.values.set(key,changed);assert.equal((await h.call('recover-response',input)).status,409);
  }
  h.values.set(key,original);assert.equal((await h.call('recover-response',{...input,walletClaim:{...input.walletClaim,claimId:'d'.repeat(64)}})).status,409);
  h.values.set(failureKey(full.order),{});assert.equal((await h.call('recover-response',input)).status,409);h.values.delete(failureKey(full.order));
  h.values.set(expiryKey(full.order),{});assert.equal((await h.call('recover-response',input)).status,409);assert.equal(f.calls.length,count);
});
test('transport rejects altered proof/bindings; controller recovers a lost local ack without repeated HTTP',async()=>{
  const h=harness(),full=f.signedInput('response-client');await h.prepare(full);const input=missingResponse(full);f.receipt(full.response.transactionBase64);
  const found=await report(await h.call('recover-response',input));
  for(const edit of [v=>v.orderRevision++,v=>v.walletClaimSha256='0'.repeat(64),v=>v.result.status='unknown',v=>v.result.signature='wrong',v=>v.response.transactionBase64='AAAA',v=>v.retryAuthorized=true]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,init)=>{const body=JSON.parse(init.body),r=structuredClone(found);edit(r);return Response.json({version:1,nonce:body.nonce,report:r});}});
    await assert.rejects(transport.recoverResponse(input));
  }
  let state={status:'wallet-response-unknown',input},requests=0,saves=0;
  const client=createBuyerResponseRecovery({scope:{},transport:{recoverResponse:async()=>{requests++;return found;}},storage:{
    readBuyerResponseRecovery:async()=>state,saveRecoveredBuyerResponse:async()=>{saves++;state={status:'verified'};throw Error('LOST_LOCAL_ACK');}}});
  await assert.rejects(client.recoverMissingResponse(),/LOST_LOCAL_ACK/);assert.equal((await client.recoverMissingResponse()).status,'already-recorded');assert.equal(requests,1);assert.equal(saves,1);
});
