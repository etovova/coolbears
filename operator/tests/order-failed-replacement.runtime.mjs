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
const origin='https://buyer-failed-replacement-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-failed-replacement-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function prepare(input){
  const order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));const quote=(await report(await call('check',fixture.input(input.order.id)))).costQuote;
  return{version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
}
async function failed(id,consume=false){
  fixture.setGeneration(1);fixture.setMode('normal');const first=fixture.signedInput(id);let approval;
  if(consume){approval=await prepare(first);assert.equal((await report(await call('send',first,{costApproval:approval}))).status,'accepted');}
  else fixture.receipt(first.response.transactionBase64);
  fixture.setMode('failure-finalized');const proof=await report(await call('recover',first));assert.equal(proof.status,'failed');
  fixture.setMode('normal');fixture.setGeneration(2);return{first,source:closeAttempt(fixture,first,proof),proof,approval};
}
const replace=source=>call('replace',source,{acknowledgedFeeLamports:'10000'});
try{
  await runtime.start();const {first,source,proof,approval}=await failed('runtime-failed-replace',true),before=fixture.calls.length;
  assert.equal((await call('replace',source)).status,400);assert.equal((await call('replace',source,{acknowledgedFeeLamports:'9999'})).status,409);
  assert.equal(fixture.calls.length,before);const prepared=await report(await replace(source));assert.equal(prepared.record.version,2);
  assert.equal(prepared.record.acknowledgedFeeLamports,'10000');assert.deepEqual(prepared.record.prior.evidence,proof.evidence);
  cases.push('exact paid fee acknowledgment and retained finalized failure precede a single persisted unsigned replacement');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const retainedCalls=fixture.calls.length;
  const restored=await report(await replace(source));assert.equal(restored.restored,true);assert.deepEqual(restored.record,prepared.record);assert.equal(fixture.calls.length,retainedCalls);
  cases.push('lost successful reply and credential rotation restore identical SQLite replacement and paid fee without RPC');
  await runtime.stop();await runtime.start();
  const partial=replacementPartial(fixture,source,restored),second=signReplacement(fixture,partial);
  assert.equal((await call('send',second,{costApproval:approval})).status,409);assert.equal(fixture.calls.length,retainedCalls);
  const quote=(await report(await call('check',partial))).costQuote,fresh={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
  assert.equal((await report(await call('send',second,{costApproval:fresh}))).status,'accepted');
  await runtime.stop();await runtime.start();const sends=fixture.calls.filter(c=>c.method==='sendTransaction').length;
  assert.equal((await call('send',first,{costApproval:approval})).status,409);assert.equal((await call('send',second,{costApproval:fresh})).status,409);
  assert.equal((await report(await call('recover',second))).status,'verified');assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,sends);
  assert.deepEqual((await report(await call('recover',first))).evidence,proof.evidence);
  cases.push('fresh cost consent authorizes distinct second bytes once; restart verifies success while old failed bytes and paid fee stay retained');
  const again=await failed('runtime-failed-again'),replacement=await report(await replace(again.source));
  const next=signReplacement(fixture,replacementPartial(fixture,again.source,replacement));fixture.receipt(next.response.transactionBase64);fixture.setMode('failure-finalized');
  const secondFailure=await report(await call('recover',next));assert.equal(secondFailure.status,'failed');
  await runtime.stop();await runtime.start();const finalCalls=fixture.calls.length;
  assert.equal((await report(await call('recover',next))).evidence.feeLamports,'10000');assert.equal((await report(await call('recover',again.first))).evidence.feeLamports,'10000');
  assert.equal((await replace(closeAttempt(fixture,next,secondFailure))).status,400);assert.equal(fixture.calls.length,finalCalls);
  cases.push('failed gateway-unsent first receipt supports one replacement; second failure retains both fees and denies third attempts after restart');
  const expires=await failed('runtime-failed-then-expired'),secondTemplate=await report(await replace(expires.source));
  const unsent=signReplacement(fixture,replacementPartial(fixture,expires.source,secondTemplate));fixture.setMode('expiry-clear');
  const expiry=await report(await call('review-expiry',unsent));assert.equal(expiry.status,'expired');
  await runtime.stop();await runtime.start();const lastCalls=fixture.calls.length;
  assert.equal((await report(await call('review-expiry',unsent))).restored,true);assert.equal((await report(await call('recover',expires.first))).evidence.feeLamports,'10000');
  assert.equal((await replace(closeAttempt(fixture,unsent,expiry))).status,400);assert.equal(fixture.calls.length,lastCalls);
  cases.push('second expiry and first paid failure remain distinct terminal records after restart without a third attempt');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:fixture.calls.filter(c=>c.method==='sendTransaction').length,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
