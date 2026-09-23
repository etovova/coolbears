// Closed Devnet fixtures only: no actual wallet, RPC or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {expiryKey,validateBuyerExpiryResult} from '../orders/expiry-review.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://expiry-review.test',nonce='a'.repeat(64);
function harness(){
  const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-expiry:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;
    try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-expiry:')&&!saved.has(k))){fault=null;throw Error('lost durable commit reply');}
    return result;
  }};
  const create=()=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const rpc=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const body=await r.json();rewrite(rpc,body);return Response.json(body);}});
  let gate=create();const call=(route,input,extra={})=>gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({version:1,nonce,...input,...extra})}));
  const review=input=>call('review-expiry',input,{authorizeExpiryReview:true});
  const prepare=async input=>{f.setMode('normal');const order=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
    const r=await call('prepare',{order});assert.equal(r.status,200,await r.clone().text());now+=1000;f.setMode('expiry-clear');};
  return{values,call,review,prepare,advance:()=>{now+=46000;},restart:()=>{gate=create();},fault:v=>{fault=v;},rewrite:v=>{rewrite=v;}};
}
const body=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
test('signed expiry commits exact evidence and restores without RPC after restart and changed pause revision',async()=>{
  const h=harness(),input=f.signedInput('expiry-durable');await h.prepare(input);const before=f.calls.length,report=await body(await h.review(input));
  validateBuyerExpiryResult(report,input);assert.equal(report.status,'expired');assert.equal(report.retryAuthorized,false);
  assert.equal(report.networkRequests,14);assert.ok(h.values.has(expiryKey(input.order)));
  const calls=f.calls.slice(before);assert.equal(calls.some(c=>/send|simulate|LatestBlockhash/.test(c.method)),false);
  assert.equal(calls.filter(c=>c.method==='getSignatureStatuses').length,3);
  h.restart();const paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:3})},saved=f.calls.length;
  const restored=await body(await h.review(paused));assert.equal(restored.restored,true);assert.equal(restored.orderRevision,4);assert.equal(f.calls.length,saved);
  assert.deepEqual(restored.proof,report.proof);assert.equal(restored.networkRequests,0);
});
test('explicit review and original server anchor are mandatory before RPC',async()=>{
  const h=harness(),input=f.signedInput('expiry-missing'),before=f.calls.length;
  assert.equal((await h.call('review-expiry',input)).status,400);
  assert.equal((await h.call('review-expiry',input,{authorizeExpiryReview:false})).status,400);
  assert.equal((await h.review(input)).status,409);
  assert.equal((await h.call('review-expiry',input,{authorizeExpiryReview:true,anchor:f.preparations.get(anchorKey(input.order)).anchor})).status,400);
  assert.equal(f.calls.length,before);assert.equal(h.values.size,0);
});
test('live hash, incomplete/pruned history, observed signature or asset never retire the attempt',async()=>{
  for(const mode of ['expiry-live','expiry-empty','expiry-pruned','expiry-observed','expiry-asset','expiry-asset-history']){
    const h=harness(),input=f.signedInput(mode);await h.prepare(input);f.setMode(mode);
    const report=await body(await h.review(input));assert.equal(report.status,'unknown',mode);assert.equal(report.chainVerified,false);
    assert.equal(report.retryAuthorized,false);assert.equal(h.values.has(expiryKey(input.order)),false);
  }
});
test('forked anchor, old contexts and receipt appearing at the final reread remain unknown',async()=>{
  const edits=[(c,b)=>{if(c.method==='getBlock'&&c.params[0]===600)b.result.blockhash=f.key('fork').publicKey.toBase58();},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=899;},
    (c,b)=>{if(c.method==='getSignaturesForAddress'&&c.params[0]===f.policy.owner)b.result[0].confirmationStatus='confirmed';},
    (c,b)=>{if(c.method==='getBlock'&&c.params[0]===900)b.result.blockHeight=2000;}];
  for(const [i,edit]of edits.entries()){
    const h=harness(),input=f.signedInput('expiry-context-'+i);await h.prepare(input);h.rewrite(edit);
    assert.equal((await body(await h.review(input))).status,'unknown');assert.equal(h.values.has(expiryKey(input.order)),false);
  }
  const h=harness(),input=f.signedInput('expiry-late-receipt');await h.prepare(input);let statuses=0;
  h.rewrite((c,b)=>{if(c.method==='getSignatureStatuses'&&++statuses===3)b.result.value[0]={slot:950,err:null};});
  assert.equal((await body(await h.review(input))).status,'unknown');assert.equal(statuses,3);assert.equal(h.values.has(expiryKey(input.order)),false);
});
test('failed or silently dropped evidence writes give no successful expiry report',async()=>{
  for(const fault of ['write','drop']){
    const h=harness(),input=f.signedInput('expiry-disk-'+fault);await h.prepare(input);h.fault(fault);
    const response=await h.review(input),r=await response.json();assert.equal(response.status,503);assert.equal(r.report,undefined);
    assert.equal(h.values.has(expiryKey(input.order)),false);assert.equal(JSON.stringify(r).includes('private disk'),false);
  }
});
test('lost successful server commit reply is recovered before cooldown without redoing RPC',async()=>{
  const h=harness(),input=f.signedInput('expiry-ack');await h.prepare(input);h.fault('ack');
  assert.equal((await h.review(input)).status,503);assert.ok(h.values.has(expiryKey(input.order)));const calls=f.calls.length;
  h.restart();const report=await body(await h.review(input));assert.equal(report.status,'expired');assert.equal(report.restored,true);assert.equal(f.calls.length,calls);
});
test('retired signed-but-unsent attempt cannot use send/check/prepare after restart or order-id changes',async()=>{
  const h=harness(),input=f.signedInput('expiry-no-send');await h.prepare(input);await body(await h.review(input));h.restart();const calls=f.calls.length;
  assert.equal([...h.values.keys()].some(k=>k.startsWith('buyer-send:')),false);
  const fresh=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  for(const [route,value,extra]of [['send',input,{costApproval:f.costApproval(input)}],['check',f.input(input.order.id),{}],['prepare',{order:fresh},{}]]){
    const r=await h.call(route,value,extra);assert.equal(r.status,409);assert.equal((await r.json()).code,'ATTEMPT_EXPIRED');
  }
  const changed={...input,order:{...input.order,id:'new-id'}};assert.equal((await h.review(changed)).status,400);
  h.values.get(expiryKey(input.order)).identity.signature='wrong';assert.equal((await h.review(input)).status,409);assert.equal(f.calls.length,calls);
});
test('expiry retains an existing permanent send claim after a cost rejection',async()=>{
  const h=harness(),input=f.signedInput('expiry-consumed');await h.prepare(input);f.setMode('normal');
  const checked=await body(await h.call('check',f.input(input.order.id)));h.advance();
  const approval={version:1,quote:checked.costQuote,maxTotalLamports:checked.costQuote.budget.totalLamports,approvedAt:Date.now()};f.setMode('fee-rise');
  assert.equal((await h.call('send',input,{costApproval:approval})).status,409);
  const [key,claim]=[...h.values.entries()].find(([k])=>k.startsWith('buyer-send:'));h.advance();f.setMode('expiry-clear');
  assert.equal((await body(await h.review(input))).status,'expired');h.restart();assert.deepEqual(h.values.get(key),claim);
  const calls=f.calls.length;assert.equal((await h.call('send',input,{costApproval:approval})).status,409);assert.equal(f.calls.length,calls);
});
test('an actually observed fixture transaction cannot be closed as never executed',async()=>{
  const h=harness(),input=f.signedInput('expiry-observed-send');await h.prepare(input);f.receipt(input.response.transactionBase64);
  assert.equal((await body(await h.review(input))).status,'unknown');assert.equal(h.values.has(expiryKey(input.order)),false);
});
test('HTTP expiry result binds exact order, bytes, history evidence and terminal proof; no cost consent needed',async()=>{
  const h=harness(),input=f.signedInput('expiry-transport');await h.prepare(input);const report=await body(await h.review(input));
  for(const edit of [r=>r.orderSha256='0'.repeat(64),r=>r.evidence.lastValidBlockHeight++,r=>r.evidence.anchorSlot=10000,
    r=>r.proof.accountAbsent=false,r=>r.proof.signature=null,r=>r.retryAuthorized=true,r=>r.evidence.historySha256='bad']){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_url,init)=>{
      const request=JSON.parse(init.body);assert.equal(request.authorizeExpiryReview,true);assert.equal(request.costApproval,undefined);
      const changed=structuredClone(report);edit(changed);return Response.json({version:1,nonce:request.nonce,report:changed});}});
    await assert.rejects(transport.reviewExpiry(input));
  }
});
test('sender review requires an explicit action and recovered local commit never repeats network or wallet',async()=>{
  const h=harness(),input=f.signedInput('expiry-sender');await h.prepare(input);const report=await body(await h.review(input));
  let state={status:'ready',input},reviews=0,saves=0;
  const sender=createBuyerSender({scope:{},storage:{readBuyerSubmission:async()=>state,saveBuyerExpiry:async()=>{
    saves++;state={status:'expired',input:{...input,order:f.model.transitionOrder(input.order,{type:'reconcile',revision:3,index:0,attempt:1,proof:report.proof})}};
    throw Error('LOST_LOCAL_ACK');}},transport:{send:()=>assert.fail('send'),recover:()=>assert.fail('recover'),reviewExpiry:async()=>{reviews++;return report;}}});
  await assert.rejects(sender.reviewExpiry(),/EXPLICIT_EXPIRY_REVIEW_REQUIRED/);assert.equal(reviews,0);
  await assert.rejects(sender.reviewExpiry({authorizeExpiryReview:true}),/LOST_LOCAL_ACK/);
  assert.equal((await sender.reviewExpiry({authorizeExpiryReview:true})).status,'already-recorded');assert.equal((await sender.recover()).outcome,'expired');
  assert.equal(reviews,1);assert.equal(saves,1);
});
