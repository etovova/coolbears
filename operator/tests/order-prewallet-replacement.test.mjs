// Closed Devnet failure receipts, all signatures/RPC are disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://prewallet-replacement.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
function harness(){
  f.setGeneration(1);f.setMode('normal');const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-replacement:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-replacement:')&&!saved.has(k))){fault=null;throw Error('lost commit reply');}return result;
  }};
  const create=(secret='fixture-secret-42')=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:secret},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const c=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const b=await r.json();rewrite(c,b);return Response.json(b);}});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  const prepare=async input=>{const order=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
    await report(await call('prepare',{order}));};
  return{values,call,prepare,restart:secret=>{gate=create(secret);},fault:v=>fault=v,rewrite:v=>rewrite=v};
}
import {prewalletRecoveryKey,validatePrewalletRecovery,prewalletReplacementSource} from '../orders/prewallet-recovery.mjs';
import {createBuyerPrewalletRecovery} from '../orders/prewallet-recovery-client.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {VersionedTransaction} from '@solana/web3.js';
const pre=(id,native=false)=>({...f.input(id),...(!native?{request:null}:{})});
import {replacementKey,validateReplacementResult,validateReplacementClaim} from '../orders/replacement.mjs';
async function failed(h,id,native=false){
  const input=pre(id,native),full=f.signedInput(id);await h.prepare(input);f.receipt(full.response.transactionBase64);f.setMode('failure-finalized');
  const found=await report(await h.call('recover-prewallet',input));
  const order=f.model.transitionOrder(input.order,{type:'reconcile',revision:1,index:0,attempt:1,proof:found.result.proof});
  const source=prewalletReplacementSource(order,input.claim,found);f.setMode('normal');f.setGeneration(2);
  return{input,full,source};
}
test('acknowledged prewallet failure prepares one fresh attempt without invented wallet rows, restores and blocks old bytes',async()=>{
  for(const native of [false,true]){
    const h=harness(),{input,full,source}=await failed(h,'prewallet-replace-'+native,native),original=structuredClone(h.values.get(prewalletRecoveryKey(input.order)));
    const count=f.calls.length;
    assert.equal((await h.call('replace',source.input,{authorizeReplacement:true})).status,400);
    assert.equal((await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'0'})).status,409);assert.equal(f.calls.length,count);
    const next=await report(await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
    validateReplacementResult(next,source.input);assert.equal(next.record.version,3);assert.deepEqual(next.record.prewallet,original);
    assert.equal(next.candidate.orderRevision,2);assert.notEqual(next.candidate.blockhash,input.claim.blockhash);
    assert.deepEqual(f.calls.slice(count).map(c=>c.method),['getGenesisHash','getMultipleAccounts','getLatestBlockhash','getBlockHeight']);
    assert.equal(h.values.has(failureKey(input.order)),false);assert.deepEqual(h.values.get(prewalletRecoveryKey(input.order)),original);
    h.restart('rotated-secret-42');const before=f.calls.length;
    const cached=await report(await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));assert.equal(cached.restored,true);assert.deepEqual(cached.record,next.record);
    assert.equal((await h.call('send',full,{costApproval:{}})).status,409);assert.equal(f.calls.length,before);
    const partial=replacementPartial(f,source.input,next);assert.equal(partial.claim.orderRevision,3);validateReplacementClaim(partial.order,partial.claim,next.record);
    h.restart();await report(await h.call('check',partial));const second=signReplacement(f,partial);f.receipt(second.response.transactionBase64);
    const done=await report(await h.call('recover',second));assert.equal(done.status,'verified');
    assert.equal((await h.call('replace',closeAttempt(f,second,done),{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,400);
  }
});
test('prewallet proof/identity corruption and ordinary-record substitution cannot authorize the second claim',async()=>{
  const h=harness(),{input,source}=await failed(h,'prewallet-replace-conflict');
  const next=await report(await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})),partial=replacementPartial(f,source.input,next);
  const key=prewalletRecoveryKey(input.order),original=structuredClone(h.values.get(key)),before=f.calls.length;
  for(const edit of [v=>v.claimSha256='0'.repeat(64),v=>v.evidence.feeLamports='1',v=>v.response.transactionBase64='AAAA']){
    const bad=structuredClone(original);edit(bad);h.values.set(key,bad);
    assert.equal((await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,409);
    assert.equal((await h.call('check',partial)).status,409);
  }
  h.values.set(key,original);h.values.set(failureKey(input.order),source.failureRecord);assert.equal((await h.call('check',partial)).status,409);h.values.delete(failureKey(input.order));
  assert.equal(f.calls.length,before);
  const mutated=structuredClone(next);mutated.record.prewallet.claimSha256='0'.repeat(64);assert.throws(()=>validateReplacementResult(mutated,source.input));
});
test('missing finalized proof, pause and reappearing asset cannot prepare a new hash',async()=>{
  const h=harness(),{input,source}=await failed(h,'prewallet-replace-block'),before=f.calls.length;
  const paused={...source.input,order:f.model.transitionOrder(source.input.order,{type:'pause',revision:2})};
  assert.equal((await h.call('replace',paused,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,400);assert.equal(f.calls.length,before);
  const key=prewalletRecoveryKey(input.order),record=h.values.get(key);h.values.delete(key);
  assert.equal((await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,409);assert.equal(f.calls.length,before);h.values.set(key,record);
  // The first failed receipt's asset has reappeared in this intercepted fixture.
  h.rewrite((c,b)=>{if(c.method==='getMultipleAccounts'&&c.params[0].length===1)b.result.value=[{lamports:1}];});
  const r=await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'});
  assert.equal(r.status,409);assert.equal(h.values.has(replacementKey(input.order)),false);
});
test('failed replacement write stays uncertain; lost durable acknowledgment restores the same prepared hash',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),{input,source}=await failed(h,'prewallet-replace-storage-'+fault);h.fault(fault);
    assert.equal((await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,503);
    assert.equal(h.values.has(replacementKey(input.order)),fault==='ack');assert.equal(h.values.has(prewalletRecoveryKey(input.order)),true);
    if(fault==='ack'){h.restart('rotated-secret-42');const before=f.calls.length;
      assert.equal((await report(await h.call('replace',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))).restored,true);assert.equal(f.calls.length,before);}
  }
});
test('replacement controller requires explicit fee review and validates transport proof without signing',async()=>{
  const h=harness(),{source}=await failed(h,'prewallet-replace-client');let calls=0;
  const controller=createBuyerPrewalletRecovery({scope:{},storage:{readPrewalletRecovery:async()=>null,savePrewalletRecovery:async()=>{},readPrewalletReplacement:async()=>source},
    transport:{recoverPrewallet:async()=>{},replace:async(input,extra)=>{calls++;return report(await h.call('replace',input,{authorizeReplacement:true,...extra}));}}});
  await assert.rejects(controller.prepareReplacement(),/EXPLICIT_REPLACEMENT_REQUIRED/);
  await assert.rejects(controller.prepareReplacement({authorizeReplacement:true}),/PAID_FEE_ACKNOWLEDGMENT_REQUIRED/);assert.equal(calls,0);
  const next=await controller.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'});assert.equal(next.record.version,3);assert.equal(calls,1);
  for(const edit of [v=>v.record.prewallet.claimSha256='0'.repeat(64),v=>v.record.prior.evidence.feeLamports='1',v=>v.candidate.orderRevision++,v=>v.record.acknowledgedFeeLamports='0']){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,init)=>{const body=JSON.parse(init.body),r=structuredClone(next);edit(r);return Response.json({version:1,nonce:body.nonce,report:r});}});
    await assert.rejects(transport.replace(source.input,{acknowledgedFeeLamports:'10000'}));
  }
  assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
