// Actual workerd/SQLite with intercepted failure receipts and disposable keys.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime} from './fixtures/buyer-gateway-runtime.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const origin='https://buyer-prewallet-replacement-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-prewallet-replacement-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function prepare(input){
  const order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));
}
const pre=(id,native=false)=>({...fixture.input(id),...(!native?{request:null}:{})});
import {prewalletReplacementSource} from '../orders/prewallet-recovery.mjs';
try{
  await runtime.start();
  for(const native of [false,true]){
    fixture.setGeneration(1);fixture.setMode('normal');const input=pre('runtime-prewallet-replacement-'+native,native),full=fixture.signedInput(input.order.id);await prepare(input);
    fixture.receipt(full.response.transactionBase64);fixture.setMode('failure-finalized');const found=await report(await call('recover-prewallet',input));
    const closed=fixture.model.transitionOrder(input.order,{type:'reconcile',revision:1,index:0,attempt:1,proof:found.result.proof}),source=prewalletReplacementSource(closed,input.claim,found);
    const count=fixture.calls.length;assert.equal((await call('replace',source.input,{acknowledgedFeeLamports:'0'})).status,409);assert.equal(fixture.calls.length,count);
    fixture.setGeneration(2);fixture.setMode('normal');assert.equal((await call('replace',source.input,{acknowledgedFeeLamports:'10000'})).status,200); // Discard reply.
    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const savedCalls=fixture.calls.length;
    const next=await report(await call('replace',source.input,{acknowledgedFeeLamports:'10000'}));assert.equal(next.restored,true);assert.equal(next.record.version,3);
    assert.equal((await call('send',full,{costApproval:{}})).status,409);assert.equal(fixture.calls.length,savedCalls);
    await runtime.stop();await runtime.start();const partial=replacementPartial(fixture,source.input,next);assert.equal(partial.claim.orderRevision,3);
    const checked=await report(await call('check',partial)),second=signReplacement(fixture,partial);
    assert.equal((await call('send',second,{costApproval:{}})).status,409);
    const quote=checked.costQuote,approval={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
    assert.equal((await report(await call('send',second,{costApproval:approval}))).status,'accepted');
    if(native)fixture.setMode('failure-finalized');const done=await report(await call('recover',second));assert.equal(done.status,native?'failed':'verified');
    if(native)assert.equal((await call('replace',closeAttempt(fixture,second,done),{acknowledgedFeeLamports:'10000'})).status,400);
    cases.push(native?'saved-partial failure replacement retains both fees, needs fresh consent, and refuses any third attempt':'missing-native failure replacement restores after lost reply and secret rotation, then uses a distinct second signed attempt with fresh consent');
    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const before=fixture.calls.length;
    assert.equal((await report(await call('recover-prewallet',input))).result.evidence.feeLamports,'10000');
    assert.equal((await call('send',second,{costApproval:approval})).status,409);assert.equal(fixture.calls.length,before);
    cases.push('both complete SQLite restart and retained first proof keep every previously consumed send closed');
    await runtime.stop();await runtime.start();
  }
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,2);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:2,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
