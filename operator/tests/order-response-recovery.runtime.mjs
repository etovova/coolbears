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
const origin='https://buyer-response-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-response-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function prepare(input){
  const order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));const quote=(await report(await call('check',fixture.input(input.order.id)))).costQuote;
  return{version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
}
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
try{
  await runtime.start();const full=fixture.signedInput('runtime-response-success');await prepare(full);const input=missingResponse(full);
  fixture.receipt(full.response.transactionBase64);const found=await report(await call('recover-response',input));
  assert.equal(found.status,'response-recovered');assert.equal(found.result.status,'verified');assert.deepEqual(found.response,full.response);
  cases.push('finalized exact bytes and Core asset proof persist together without any submission');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});let before=fixture.calls.length;
  const paused={...input,order:fixture.model.transitionOrder(input.order,{type:'pause',revision:2})};
  assert.equal((await report(await call('recover-response',paused))).restored,true);
  assert.equal((await report(await call('recover',full))).restored,true);
  assert.equal((await call('send',full,{costApproval:{}})).status,409);
  assert.equal((await call('check',fixture.input(full.order.id))).status,409);assert.equal(fixture.calls.length,before);
  cases.push('full SQLite restart and credential rotation restore/rebind proof and permanently block old send/check');
  await runtime.stop();await runtime.start();const failed=fixture.signedInput('runtime-response-failed');await prepare(failed);
  fixture.receipt(failed.response.transactionBase64);fixture.setMode('failure-finalized');const lost=missingResponse(failed);
  assert.equal((await call('recover-response',lost)).status,200); // Deliberately discard committed response.
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  const restored=await report(await call('recover-response',lost));assert.equal(restored.restored,true);assert.equal(restored.result.status,'failed');
  assert.equal(restored.result.evidence.feeLamports,'10000');assert.equal((await report(await call('recover',failed))).status,'failed');
  assert.equal(fixture.calls.length,before);assert.equal((await call('send',failed,{costApproval:{}})).status,409);
  cases.push('lost HTTP response restores atomic discovered response and normalized paid failure record after restart without RPC');
  await runtime.stop();await runtime.start();fixture.setMode('normal');const absent=fixture.signedInput('runtime-response-absent');await prepare(absent);
  assert.equal((await report(await call('recover-response',missingResponse(absent)))).status,'unknown');
  fixture.receipt(absent.response.transactionBase64);fixture.setMode('pending');
  assert.equal((await report(await call('recover-response',missingResponse(absent)))).status,'unknown');fixture.setMode('normal');
  assert.equal((await report(await call('recover-response',missingResponse(absent)))).result.status,'verified');
  cases.push('empty or nonfinalized history cannot release a missing response; later exact finalized evidence can close it');
  fixture.setGeneration(2);const source=closeAttempt(fixture,failed,restored.result);
  const replacement=await report(await call('replace',source,{acknowledgedFeeLamports:'10000'}));
  const second=signReplacement(fixture,replacementPartial(fixture,source,replacement));fixture.receipt(second.response.transactionBase64);
  const secondMissing=missingResponse(second),terminal=await report(await call('recover-response',secondMissing));assert.equal(terminal.result.proof.slot,1450);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  assert.equal((await report(await call('recover-response',lost))).result.status,'failed');
  assert.equal((await report(await call('recover-response',secondMissing))).result.status,'verified');assert.equal(fixture.calls.length,before);
  cases.push('separate acknowledged replacement preserves first fee proof and second response across SQLite restart');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
