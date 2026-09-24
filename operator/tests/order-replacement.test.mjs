// Full replacement protocol using disposable fixture signatures and intercepted RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {replacementKey,validateReplacementResult} from '../orders/replacement.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://replacement.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const approval=r=>({version:1,quote:r.costQuote,maxTotalLamports:r.costQuote.budget.totalLamports,approvedAt:Date.now()});
function harness(){
  f.setGeneration(1);f.setMode('normal');const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-replacement:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-replacement:')&&!saved.has(k))){fault=null;throw Error('lost commit reply');}return result;
  }};
  const create=()=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const c=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const b=await r.json();rewrite(c,b);return Response.json(b);}});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  const replace=input=>call('replace',input,{authorizeReplacement:true});
  const review=input=>call('review-expiry',input,{authorizeExpiryReview:true});
  const expire=async(id,consume=false)=>{
    const first=f.signedInput(id),fresh=f.model.createOrder({...first.order,available:9999,assets:first.order.items.map(i=>i.asset)});
    await report(await call('prepare',{order:fresh}));const cost=approval(await report(await call('check',f.input(id))));
    if(consume){f.setMode('fee-rise');assert.equal((await call('send',first,{costApproval:cost})).status,409);}
    f.setMode('expiry-clear');const proof=await report(await review(first));assert.equal(proof.status,'expired');
    f.setMode('normal');f.setGeneration(2);return{first,expired:closeAttempt(f,first,proof),cost};
  };
  return{values,call,replace,review,expire,restart:()=>{gate=create();},fault:v=>fault=v,rewrite:v=>rewrite=v,advance:()=>now+=46000};
}
test('replacement preserves first anchor, evidence and consumed send; fresh quote/signature/send verifies second attempt',async()=>{
  const h=harness(),{first,expired,cost}=await h.expire('replacement-linked',true),saved=structuredClone(h.values),start=f.calls.length;
  const prepared=await report(await h.replace(expired));validateReplacementResult(prepared,expired);assert.equal(prepared.signaturesCreated,0);
  assert.deepEqual(f.calls.slice(start).map(c=>c.method),['getGenesisHash','getMultipleAccounts','getLatestBlockhash','getBlockHeight']);
  for(const [k,v]of saved)if(k.startsWith('buyer-blockhash:')||k.startsWith('buyer-send:')||k.startsWith('buyer-expiry:'))assert.deepEqual(h.values.get(k),v);
  const partial=replacementPartial(f,expired,prepared),second=signReplacement(f,partial);assert.equal(second.claim.attempt,2);
  assert.notEqual(second.response.transactionBase64,first.response.transactionBase64);assert.equal(second.claim.asset,first.claim.asset);
  const before=f.calls.length;assert.equal((await h.call('send',second,{costApproval:cost})).status,409);assert.equal(f.calls.length,before);
  const fresh=approval(await report(await h.call('check',partial)));assert.notEqual(fresh.quote.requestId,cost.quote.requestId);
  h.restart();assert.equal((await report(await h.call('send',second,{costApproval:fresh}))).status,'accepted');
  const sends=f.calls.filter(c=>c.method==='sendTransaction').length;h.restart();assert.equal((await h.call('send',second,{costApproval:fresh})).status,409);
  assert.equal((await h.call('send',first,{costApproval:cost})).status,409);
  const recovered=await report(await h.call('recover',second));assert.equal(recovered.status,'verified');
  assert.equal(closeAttempt(f,second,recovered).order.items[0].attempts[1].state,'verified');
  assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,sends);
  assert.equal([...h.values.keys()].filter(k=>k.startsWith('buyer-send:')).length,2);
});
test('restart, lost commit reply and pause/resume restore one identical replacement without new RPC or signatures',async()=>{
  const h=harness(),{expired}=await h.expire('replacement-ack');h.fault('ack');assert.equal((await h.replace(expired)).status,503);
  const retained=structuredClone(h.values.get(replacementKey(expired.order))),before=f.calls.length;h.restart();
  const restored=await report(await h.replace(expired));assert.equal(restored.restored,true);assert.deepEqual(restored.record,retained);
  const paused={...expired,order:f.model.transitionOrder(expired.order,{type:'pause',revision:4})};
  assert.equal((await h.replace(paused)).status,400);const resumed={...expired,order:f.model.transitionOrder(paused.order,{type:'resume',revision:5})};
  const again=await report(await h.replace(resumed));assert.equal(again.candidate.orderRevision,6);
  assert.deepEqual(again.record,retained);assert.equal(again.candidate.transactionBase64,restored.candidate.transactionBase64);assert.equal(f.calls.length,before);
});
test('explicit replacement, authentic retained expiry, unchanged record and server provenance are mandatory',async()=>{
  const h=harness(),{first,expired}=await h.expire('replacement-required'),before=f.calls.length;
  assert.equal((await h.call('replace',expired)).status,400);assert.equal((await h.replace(first)).status,400);
  const key=expiryKey(expired.order),prior=h.values.get(key);h.values.delete(key);
  assert.equal((await h.replace(expired)).status,409);assert.equal(f.calls.length,before);h.values.set(key,prior);
  const prepared=await report(await h.replace(expired)),partial=replacementPartial(f,expired,prepared),record=h.values.get(replacementKey(expired.order));
  h.values.delete(replacementKey(expired.order));const calls=f.calls.length;
  assert.equal((await h.call('check',partial)).status,409);assert.equal(f.calls.length,calls);
  h.values.set(replacementKey(expired.order),record);record.anchor.lastValidBlockHeight++;
  assert.equal((await h.replace(expired)).status,409);assert.equal((await h.call('check',partial)).status,409);assert.equal(f.calls.length,calls);
});
test('write failure or dropped replacement storage cannot grant signing and never destroys the old expiry',async()=>{
  for(const fault of ['write','drop']){const h=harness(),{expired}=await h.expire('replacement-'+fault),prior=structuredClone(h.values.get(expiryKey(expired.order)));
    h.fault(fault);const r=await h.replace(expired);assert.equal(r.status,503);assert.equal((await r.json()).report,undefined);
    assert.equal(h.values.has(replacementKey(expired.order)),false);assert.deepEqual(h.values.get(expiryKey(expired.order)),prior);}
});
test('old hash, short lifetime, stale context, observed asset and wrong genesis refuse a replacement',async()=>{
  const edits=[(c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.blockhash=f.key('hash').publicKey.toBase58();},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.lastValidBlockHeight=2101;},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.context.slot=999;},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.value[0]={owner:'observed'};},
    (c,b)=>{if(c.method==='getGenesisHash')b.result='wrong';}];
  for(const [n,edit]of edits.entries()){const h=harness(),{expired}=await h.expire('replacement-rpc-'+n);h.rewrite(edit);
    assert.notEqual((await h.replace(expired)).status,200);assert.equal(h.values.has(replacementKey(expired.order)),false);}
});
test('second expiry uses its own anchor/tombstone, retains first history and cannot grant a third attempt',async()=>{
  const h=harness(),{first,expired}=await h.expire('replacement-second-expiry'),prepared=await report(await h.replace(expired));
  const second=signReplacement(f,replacementPartial(f,expired,prepared));f.setMode('expiry-clear');
  const reviewed=await report(await h.review(second));assert.equal(reviewed.status,'expired');assert.equal(reviewed.evidence.anchorSlot,1200);
  const thirdSource=closeAttempt(f,second,reviewed);h.restart();const before=f.calls.length;
  assert.equal((await h.replace(thirdSource)).status,400);assert.equal((await report(await h.review(second))).restored,true);
  assert.equal(h.values.has(expiryKey(first.order)),true);assert.equal(h.values.has(expiryKey(second.order,2)),true);
  assert.equal((await h.call('send',second,{costApproval:{}})).status,409);assert.equal(f.calls.length,before);
  assert.equal(h.values.get(anchorKey(first.order)).anchor.blockhash,first.claim.blockhash);
});
test('HTTPS adapter rejects changed bindings; sender preparation is explicit and never signs, sends or mutates local history',async()=>{
  const h=harness(),{expired}=await h.expire('replacement-transport'),prepared=await report(await h.replace(expired));
  for(const edit of [r=>r.previousRequestId='0'.repeat(64),r=>r.record.prior.proof.blockHeight++,r=>r.candidate.orderRevision++,r=>r.readyToSign=true]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(url,init)=>{assert.equal(url,origin+'/api/buyer/replace');
      const request=JSON.parse(init.body);assert.equal(request.authorizeReplacement,true);assert.equal(init.credentials,'omit');
      const value=structuredClone(prepared);edit(value);return Response.json({version:1,nonce:request.nonce,report:value});}});
    await assert.rejects(transport.replace(expired));
  }
  let calls=0;const sender=createBuyerSender({scope:{},storage:{readBuyerSubmission:async()=>({status:'expired',input:expired})},
    transport:{send:()=>assert.fail('send'),recover:()=>assert.fail('recover'),replace:async()=>{calls++;return prepared;}}});
  await assert.rejects(sender.prepareReplacement(),/EXPLICIT_REPLACEMENT_REQUIRED/);assert.equal(calls,0);
  assert.deepEqual(await sender.prepareReplacement({authorizeReplacement:true}),prepared);assert.equal(calls,1);
});
