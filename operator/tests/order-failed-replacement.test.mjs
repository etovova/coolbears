// Full replacement protocol using disposable fixture signatures and intercepted RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {replacementKey,validateReplacementResult} from '../orders/replacement.mjs';
import {failureKey} from '../orders/failure-record.mjs';
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
  const replace=(input,acknowledgedFeeLamports='10000')=>call('replace',input,{authorizeReplacement:true,acknowledgedFeeLamports});
  const review=input=>call('review-expiry',input,{authorizeExpiryReview:true});
  const fail=async(id,consume=true)=>{
    const first=f.signedInput(id);let cost;
    if(consume){const fresh=f.model.createOrder({...first.order,available:9999,assets:first.order.items.map(i=>i.asset)});
      await report(await call('prepare',{order:fresh}));cost=approval(await report(await call('check',f.input(id))));
      assert.equal((await report(await call('send',first,{costApproval:cost}))).status,'accepted');
    }else f.receipt(first.response.transactionBase64);
    f.setMode('failure-finalized');const failed=await report(await call('recover',first));assert.equal(failed.status,'failed');
    f.setMode('normal');f.setGeneration(2);return{first,source:closeAttempt(f,first,failed),cost,failed};
  };
  return{values,call,replace,review,fail,restart:()=>{gate=create();},fault:v=>fault=v,rewrite:v=>rewrite=v,advance:()=>now+=46000};
}
test('failed replacement retains charged fee and first claims; fresh consent gates a distinct second signed send and recovery',async()=>{
  const h=harness(),{first,source,cost}=await h.fail('failed-replace-linked'),saved=structuredClone(h.values),start=f.calls.length;
  const prepared=await report(await h.replace(source));validateReplacementResult(prepared,source);
  assert.equal(prepared.record.version,2);assert.equal(prepared.record.acknowledgedFeeLamports,'10000');assert.equal(prepared.signaturesCreated,0);
  assert.deepEqual(prepared.record.prior,saved.get(failureKey(first.order)));
  assert.deepEqual(f.calls.slice(start).map(c=>c.method),['getGenesisHash','getMultipleAccounts','getLatestBlockhash','getBlockHeight']);
  for(const [k,v]of saved)if(k!=='buyer-check-budget:v1')assert.deepEqual(h.values.get(k),v);
  const partial=replacementPartial(f,source,prepared),second=signReplacement(f,partial);
  assert.notEqual(second.claim.blockhash,first.claim.blockhash);assert.notEqual(second.response.transactionBase64,first.response.transactionBase64);
  assert.deepEqual(second.order.items[0].attempts[0],source.order.items[0].attempts[0]);
  const before=f.calls.length;assert.equal((await h.call('send',second,{costApproval:cost})).status,409);assert.equal(f.calls.length,before);
  const fresh=approval(await report(await h.call('check',partial)));assert.notEqual(fresh.quote.requestId,cost.quote.requestId);
  h.restart();assert.equal((await report(await h.call('send',second,{costApproval:fresh}))).status,'accepted');
  h.restart();const sent=f.calls.filter(c=>c.method==='sendTransaction').length;
  assert.equal((await h.call('send',first,{costApproval:cost})).status,409);assert.equal((await h.call('send',second,{costApproval:fresh})).status,409);
  const recovered=await report(await h.call('recover',second));assert.equal(recovered.status,'verified');
  assert.deepEqual(closeAttempt(f,second,recovered).order.items[0].attempts.map(a=>a.state),['failed','verified']);
  assert.equal(h.values.get(failureKey(first.order)).evidence.feeLamports,'10000');
  assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,sent);assert.equal([...h.values.keys()].filter(k=>k.startsWith('buyer-send:')).length,2);
});
test('exact paid fee acknowledgment and authentic exclusive retained failure are required before any RPC',async()=>{
  const h=harness(),{first,source}=await h.fail('failed-replace-auth',false),before=f.calls.length;
  assert.equal((await h.call('replace',source,{authorizeReplacement:true})).status,400);
  for(const fee of ['0','9999','010000',10000,null])assert.equal((await h.replace(source,fee)).status,409);
  assert.equal((await h.replace(first)).status,400);
  const key=failureKey(source.order),prior=structuredClone(h.values.get(key));h.values.delete(key);
  assert.equal((await h.replace(source)).status,409);h.values.set(key,structuredClone(prior));
  h.values.get(key).evidence.payerDebitLamports='9999';assert.equal((await h.replace(source)).status,409);h.values.set(key,structuredClone(prior));
  h.values.set(expiryKey(source.order),{});assert.equal((await h.replace(source)).status,409);h.values.delete(expiryKey(source.order));
  assert.equal(f.calls.length,before);assert.equal(h.values.has(replacementKey(source.order)),false);
  const prepared=await report(await h.replace(source)),partial=replacementPartial(f,source,prepared),calls=f.calls.length;
  h.values.delete(key);assert.equal((await h.call('check',partial)).status,409);h.values.set(key,prior);
  h.values.set(expiryKey(source.order),{});assert.equal((await h.call('check',partial)).status,409);assert.equal(f.calls.length,calls);
});
test('write/drop/commit acknowledgment faults preserve the failed source and restore only the same second template',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),{source}=await h.fail('failed-replace-'+fault,false),prior=structuredClone(h.values.get(failureKey(source.order)));
    h.fault(fault);assert.equal((await h.replace(source)).status,503);assert.deepEqual(h.values.get(failureKey(source.order)),prior);
    assert.equal(h.values.has(replacementKey(source.order)),fault==='ack');
    if(fault==='ack'){
      const retained=structuredClone(h.values.get(replacementKey(source.order))),before=f.calls.length;h.restart();
      const restored=await report(await h.replace(source));assert.equal(restored.restored,true);assert.deepEqual(restored.record,retained);
      const paused={...source,order:f.model.transitionOrder(source.order,{type:'pause',revision:4})};assert.equal((await h.replace(paused)).status,400);
      const resumed={...source,order:f.model.transitionOrder(paused.order,{type:'resume',revision:5})};
      f.setMode('near-expiry');const rebound=await report(await h.replace(resumed));assert.deepEqual(rebound.record,retained);assert.equal(rebound.candidate.orderRevision,6);
      assert.equal((await h.replace(resumed,'0')).status,409);assert.equal(f.calls.length,before);
    }
  }
});
test('finalized account floor excludes newer status context; new hash context and lifetime remain independently bounded',async()=>{
  const h=harness();h.rewrite((c,b)=>{if(c.method==='getSignatureStatuses')b.result.context.slot=1000;});
  const {source}=await h.fail('failed-replace-context',false);h.rewrite((c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=700;});const start=f.calls.length;
  const prepared=await report(await h.replace(source));assert.equal(prepared.record.prior.evidence.statusSlot,1000);
  assert.equal(f.calls.slice(start).find(c=>c.method==='getMultipleAccounts').params[1].minContextSlot,700);
  assert.equal(f.calls.slice(start).find(c=>c.method==='getLatestBlockhash').params[0].minContextSlot,1000);
  const edits=[(c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.blockhash=f.key('hash').publicKey.toBase58();},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.lastValidBlockHeight=2000;},
    (c,b)=>{if(c.method==='getBlockHeight')b.result=2521;},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.context.slot=699;},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=699;},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.value[0]={owner:'observed'};}];
  for(const [n,edit]of edits.entries()){const g=harness(),{source:s}=await g.fail('failed-replace-rpc-'+n,false);g.rewrite(edit);
    assert.notEqual((await g.replace(s)).status,200);assert.equal(g.values.has(replacementKey(s.order)),false);}
});
test('source changed during RPC cannot commit replacement and corrupted retained replacement cannot grant a second check',async()=>{
  const h=harness(),{source}=await h.fail('failed-replace-cas',false),key=failureKey(source.order),prior=structuredClone(h.values.get(key));
  h.rewrite((c)=>{if(c.method==='getLatestBlockhash')h.values.delete(key);});assert.equal((await h.replace(source)).status,409);
  assert.equal(h.values.has(replacementKey(source.order)),false);h.values.set(key,prior);h.rewrite(null);h.advance();
  const prepared=await report(await h.replace(source)),partial=replacementPartial(f,source,prepared),before=f.calls.length;
  h.values.get(replacementKey(source.order)).acknowledgedFeeLamports='9999';
  assert.equal((await h.replace(source)).status,409);assert.equal((await h.call('check',partial)).status,409);assert.equal(f.calls.length,before);
});
test('second failure retains both paid fee records and permanently refuses any third attempt',async()=>{
  const h=harness(),{first,source}=await h.fail('failed-replace-second',false),prior=structuredClone(h.values.get(failureKey(source.order)));
  const prepared=await report(await h.replace(source)),second=signReplacement(f,replacementPartial(f,source,prepared));
  f.receipt(second.response.transactionBase64);f.setMode('failure-finalized');const failed=await report(await h.call('recover',second));assert.equal(failed.status,'failed');
  assert.equal(h.values.get(failureKey(second.order,2)).evidence.feeLamports,'10000');assert.deepEqual(h.values.get(failureKey(first.order)),prior);
  h.restart();const before=f.calls.length;assert.equal((await report(await h.call('recover',second))).restored,true);
  assert.equal((await h.replace(closeAttempt(f,second,failed))).status,400);assert.equal((await h.call('send',first,{costApproval:{}})).status,409);
  assert.equal((await h.call('send',second,{costApproval:{}})).status,409);assert.equal(f.calls.length,before);
});
test('HTTP and sender bind the acknowledged fee and source; explicit preparation never signs, sends or changes local history',async()=>{
  const h=harness(),{source}=await h.fail('failed-replace-client',false),prepared=await report(await h.replace(source));
  for(const edit of [r=>r.record.acknowledgedFeeLamports='9999',r=>r.record.prior.evidence.feeLamports='9999',r=>r.previousSignature='wrong',r=>r.record.version=1]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,init)=>{const req=JSON.parse(init.body);assert.equal(req.acknowledgedFeeLamports,'10000');
      const value=structuredClone(prepared);edit(value);return Response.json({version:1,nonce:req.nonce,report:value});}});
    await assert.rejects(transport.replace(source,{acknowledgedFeeLamports:'10000'}));
  }
  let calls=0;const sender=createBuyerSender({scope:{},storage:{readBuyerSubmission:async()=>({status:'failed',input:source,failureRecord:prepared.record.prior})},
    transport:{send:()=>assert.fail('send'),recover:()=>assert.fail('recover'),replace:async(input,options)=>{calls++;assert.deepEqual(input,source);assert.equal(options.acknowledgedFeeLamports,'10000');return prepared;}}});
  await assert.rejects(sender.prepareReplacement({authorizeReplacement:true}),/PAID_FEE_ACKNOWLEDGMENT_REQUIRED/);
  await assert.rejects(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'9999'}),/PAID_FEE_ACKNOWLEDGMENT_REQUIRED/);assert.equal(calls,0);
  assert.deepEqual(await sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}),prepared);assert.equal(calls,1);
});
