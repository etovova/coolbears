// No live chain, wallet or send; all keys and RPC responses are disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {responseExpiryKey,validateResponseExpiry,restoreResponseExpirySubmission} from '../orders/response-expiry.mjs';
import {responseRecoveryKey} from '../orders/response-recovery.mjs';
import {prewalletRecoveryKey} from '../orders/prewallet-recovery.mjs';
import {prewalletExpiryKey} from '../orders/prewallet-expiry.mjs';
import {expiryKey,validateBuyerExpiryResult} from '../orders/expiry-review.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {replacementKey} from '../orders/replacement.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {signedBytesId} from '../orders/submission.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const history=prewalletExpiryFixture(f),{makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://response-expiry.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
function harness(){
  history.set(false);history.history();history.rewrite(undefined);f.setGeneration(1);
  const values=new Map();let now=Date.now(),fault;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-response-expiry:')){if(fault==='write')throw Error('disk');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){const saved=structuredClone(values);let result;
      try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
      if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-response-expiry:')&&!saved.has(k))){fault=null;throw Error('ack');}return result;}};
  const create=()=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>f.upstream(new Request(u,i))});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  return{values,call,review:input=>call('review-response-expiry',input,{authorizeExpiryReview:true}),restart:()=>{gate=create();},fault:v=>fault=v,
    async prepare(full,{approval=false}={}){
      await report(await call('prepare',{order:f.model.createOrder({...full.order,available:9999,assets:full.order.items.map(i=>i.asset)})}));
      let cost;if(approval){const quote=(await report(await call('check',f.input(full.order.id)))).costQuote;
        cost={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};}
      history.set();return missingResponse(full,cost);
    }};
}
const sendKey=input=>'buyer-send:v1:'+signedBytesId(JSON.stringify(['devnet',input.order.machine,input.order.collection,input.order.guard,input.order.buyer,input.claim.asset]));
test('real invocation expires with null signature; explicit late-byte expiry bridge converges without opening replacement',async()=>{
  for(const approval of [false,true]){
    const h=harness(),full=f.signedInput('response-expired-'+approval),input=await h.prepare(full,{approval}),before=f.calls.length;
    const found=await report(await h.review(input));validateResponseExpiry(found,input);
    assert.equal(found.status,'response-expired');assert.equal(found.chainVerified,true);assert.equal(found.proof.signature,null);
    assert.equal(found.evidence.historyTransactions,2);assert.equal(found.response,undefined);assert.equal(found.result,undefined);
    assert.equal(found.retryAuthorized,false);assert.equal(found.transactionsSent,0);
    assert.equal(f.calls.slice(before).some(c=>['sendTransaction','simulateTransaction','getSignatureStatuses','getLatestBlockhash'].includes(c.method)),false);
    const key=responseExpiryKey(input.order),saved=structuredClone(h.values.get(key));h.restart();const count=f.calls.length;
    const paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:input.order.revision})};
    assert.equal((await report(await h.review(paused))).restored,true);
    const prepared=f.input(full.order.id),prewallet={...prepared,request:null};
    for(const [route,value,extra]of [['check',prepared,{}],['send',full,{costApproval:{}}],['recover',full,{}],['recover-response',input,{}],
      ['recover-prewallet',prewallet,{}],['review-prewallet-expiry',prewallet,{authorizeExpiryReview:true}]])
      assert.equal((await h.call(route,value,extra)).status,409,route);
    const bridge=await report(await h.call('review-expiry',full,{authorizeExpiryReview:true}));validateBuyerExpiryResult(bridge,full);
    assert.equal(bridge.status,'expired');assert.equal(bridge.proof.signature,full.order.items[0].attempts[0].signature);
    assert.deepEqual(restoreResponseExpirySubmission(full,saved),bridge);assert.deepEqual(h.values.get(key),saved);
    assert.equal(h.values.has(expiryKey(full.order)),false);
    assert.equal((await h.call('replace',closeAttempt(f,full,bridge),{authorizeReplacement:true})).status,409);
    assert.equal(f.calls.length,count);
  }
});
test('missing response review requires explicit consent, exact invoked-wallet input and immutable saved identity',async()=>{
  const h=harness(),full=f.signedInput('response-expiry-binding');let input=missingResponse(full),count=f.calls.length;
  assert.equal((await h.review(input)).status,409);assert.equal(f.calls.length,count);input=await h.prepare(full,{approval:true});count=f.calls.length;
  assert.equal((await h.call('review-response-expiry',input)).status,400);
  for(const edit of [v=>delete v.walletClaim,v=>v.walletClaim.orderRevision++,v=>v.walletClaim.requestId='0'.repeat(64),
    v=>v.walletClaim.costApproval.maxTotalLamports='1',v=>v.request=null,v=>v.order=full.order,v=>v.response=full.response]){
    const changed=structuredClone(input);edit(changed);assert.equal((await h.review(changed)).status,400);
  }
  assert.equal(f.calls.length,count);await report(await h.review(input));count=f.calls.length;
  const key=responseExpiryKey(input.order),saved=structuredClone(h.values.get(key));
  for(const edit of [v=>v.claimSha256='0'.repeat(64),v=>v.identity.partialSha256='0'.repeat(64),v=>v.proof.signature='invented',
    v=>v.evidence.historyTransactions=0,v=>v.evidence.historyPages=3]){
    const changed=structuredClone(saved);edit(changed);h.values.set(key,changed);assert.equal((await h.review(input)).status,409);
    assert.equal((await h.call('review-expiry',full,{authorizeExpiryReview:true})).status,409);
  }
  h.values.set(key,saved);const changed=structuredClone(input);changed.walletClaim.claimId='d'.repeat(64);
  assert.equal((await h.review(changed)).status,409);
  changed.walletClaim=structuredClone(input.walletClaim);changed.walletClaim.costApproval.approvedAt--;
  assert.equal((await h.review(changed)).status,409);assert.equal(f.calls.length,count);
});
test('complete finalized bounded history is mandatory after wallet invocation; incomplete or observed outcomes stay unknown',async()=>{
  for(const [n,slots,edit]of [[0,[850],undefined],[1,Array.from({length:20},(_,i)=>850-i),undefined],
    [2,[850,599],(c,b)=>{if(c.method==='getTransaction')b.result=null;}],
    [3,[850,599],(c,b)=>{if(c.method==='getFirstAvailableBlock')b.result=601;}],
    [4,[850,599],(c,b)=>{if(c.method==='getMultipleAccounts')b.result.value=[{}];}]]){
    const h=harness(),full=f.signedInput('response-expiry-unknown-'+n),input=await h.prepare(full);history.history(slots);history.rewrite(edit);
    const found=await report(await h.review(input));assert.equal(found.status,'unknown');assert.equal(found.chainVerified,false);
    assert.equal(found.proof,undefined);assert.equal(found.response,undefined);assert.equal(h.values.has(responseExpiryKey(input.order)),false);
  }
});
test('atomic commit rejects terminal/send conflicts and changed anchors introduced during RPC',async()=>{
  const mutations=[(h,i)=>h.values.set(failureKey(i.order),{}),(h,i)=>h.values.set(expiryKey(i.order),{}),
    (h,i)=>h.values.set(responseRecoveryKey(i.order),{}),(h,i)=>h.values.set(prewalletRecoveryKey(i.order),{}),
    (h,i)=>h.values.set(prewalletExpiryKey(i.order),{}),(h,i)=>h.values.set(sendKey(i),{}),
    (h,i)=>h.values.set(replacementKey(i.order),{}),(h,i)=>h.values.set(anchorKey(i.order),{})];
  for(const [n,mutate]of mutations.entries()){
    const h=harness(),input=await h.prepare(f.signedInput('response-expiry-race-'+n));let reads=0;
    history.rewrite((c)=>{if(c.method==='getMultipleAccounts'&&++reads===2)mutate(h,input);});
    assert.equal((await h.review(input)).status,409);assert.equal(h.values.has(responseExpiryKey(input.order)),false);
  }
});
test('durable write failures never expose expiry; lost commit acknowledgment restores without RPC',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),input=await h.prepare(f.signedInput('response-expiry-storage-'+fault));h.fault(fault);
    const r=await h.review(input);assert.equal(r.status,503);assert.equal((await r.json()).report,undefined);
    assert.equal(h.values.has(responseExpiryKey(input.order)),fault==='ack');
    if(fault==='ack'){h.restart();const count=f.calls.length;assert.equal((await report(await h.review(input))).restored,true);assert.equal(f.calls.length,count);}
  }
});
test('second response expiry retains the genuine acknowledged replacement and first charged fee, including cached validation',async()=>{
  const h=harness(),full=f.signedInput('response-expiry-second');await h.prepare(full);history.set(false);f.receipt(full.response.transactionBase64);f.setMode('failure-finalized');
  const first=await report(await h.call('recover',full)),fee=structuredClone(h.values.get(failureKey(full.order)));
  assert.equal(first.evidence.feeLamports,'10000');const closed=closeAttempt(f,full,first);f.setGeneration(2);f.setMode('normal');
  const replacement=await report(await h.call('replace',closed,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  const second=signReplacement(f,replacementPartial(f,closed,replacement)),input=missingResponse(second),saved=structuredClone(h.values.get(replacementKey(second.order)));
  history.set();history.history([1500,1199]);const found=await report(await h.review(input));validateResponseExpiry(found,input);
  assert.equal(found.proof.signature,null);assert.equal(found.status,'response-expired');
  assert.deepEqual(h.values.get(failureKey(full.order)),fee);assert.deepEqual(h.values.get(replacementKey(full.order)),saved);
  h.restart();const count=f.calls.length;assert.equal((await report(await h.review(input))).restored,true);
  const corrupted=structuredClone(fee);corrupted.evidence.feeLamports='1';h.values.set(failureKey(full.order),corrupted);
  assert.equal((await h.review(input)).status,409);assert.equal(f.calls.length,count);
  assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
