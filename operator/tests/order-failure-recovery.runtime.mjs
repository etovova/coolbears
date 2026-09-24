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
const origin='https://buyer-failure-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-failure-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function prepare(input){
  const order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));const quote=(await report(await call('check',fixture.input(input.order.id)))).costQuote;
  return{version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
}
try{
  await runtime.start();const first=fixture.signedInput('runtime-failure'),approval=await prepare(first);
  assert.equal((await report(await call('send',first,{costApproval:approval}))).status,'accepted');fixture.setMode('failure-finalized');
  const failed=await report(await call('recover',first));assert.equal(failed.status,'failed');assert.equal(failed.evidence.feeLamports,'10000');assert.equal(failed.retryAuthorized,false);
  cases.push('exact finalized failure, absent asset and consistent charged fee persist after a one-shot accepted fixture submission');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const before=fixture.calls.length;
  const restored=await report(await call('recover',first));assert.equal(restored.restored,true);assert.deepEqual(restored.proof,failed.proof);assert.deepEqual(restored.evidence,failed.evidence);
  assert.equal((await call('send',first,{costApproval:approval})).status,409);assert.equal((await call('review-expiry',first)).status,409);assert.equal(fixture.calls.length,before);
  cases.push('SQLite terminal evidence and consumed send survive full runtime restart and credential rotation without new RPC');
  await runtime.stop();await runtime.start();fixture.setMode('normal');const unsent=fixture.signedInput('runtime-unsent-failure');fixture.receipt(unsent.response.transactionBase64);
  for(const mode of ['failure-pending','failure-no-fee','failure-asset']){fixture.setMode(mode);assert.equal((await report(await call('recover',unsent))).status,'unknown');}
  cases.push('pending status, missing charged fee or observed asset do not persist a terminal failure');
  fixture.setMode('failure-finalized');assert.equal((await call('recover',unsent)).status,200); // Discard committed response deliberately.
  await runtime.stop();await runtime.start();const discarded=fixture.calls.length;
  assert.equal((await report(await call('recover',unsent))).restored,true);assert.equal((await call('send',unsent,{costApproval:{}})).status,409);assert.equal(fixture.calls.length,discarded);
  cases.push('lost successful reply restores failure for a signed but gateway-unsent transaction and blocks any first send');
  fixture.setMode('normal');const original=fixture.signedInput('runtime-second-failure');await prepare(original);fixture.setMode('expiry-clear');
  const expired=closeAttempt(fixture,original,await report(await call('review-expiry',original)));fixture.setGeneration(2);fixture.setMode('normal');
  const replacement=await report(await call('replace',expired)),second=signReplacement(fixture,replacementPartial(fixture,expired,replacement));
  fixture.receipt(second.response.transactionBase64);fixture.setMode('failure-finalized');const secondFailure=await report(await call('recover',second));
  assert.equal(secondFailure.status,'failed');assert.equal(secondFailure.proof.slot,1450);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const last=fixture.calls.length;
  assert.equal((await report(await call('recover',second))).restored,true);assert.equal((await report(await call('review-expiry',original))).restored,true);
  assert.equal((await call('send',second,{costApproval:{}})).status,409);assert.equal((await call('replace',closeAttempt(fixture,second,secondFailure))).status,400);assert.equal(fixture.calls.length,last);
  cases.push('second failure and first expiry remain distinct after restart, preserving replacement provenance and denying third attempts');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:fixture.calls.filter(c=>c.method==='sendTransaction').length,
    transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
