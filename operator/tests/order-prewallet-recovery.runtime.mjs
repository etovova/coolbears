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
const origin='https://buyer-prewallet-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-prewallet-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function prepare(input){
  const order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));
}
const pre=(id,native=false)=>({...fixture.input(id),...(!native?{request:null}:{})});
try{
  await runtime.start();const full=fixture.signedInput('runtime-prewallet-success'),input=pre(full.order.id);await prepare(input);
  fixture.receipt(full.response.transactionBase64);const found=await report(await call('recover-prewallet',input));
  assert.equal(found.result.status,'verified');assert.deepEqual(found.response,full.response);
  cases.push('exact finalized native and buyer signatures recover from a saved unsigned native claim with no local wallet claim');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});let before=fixture.calls.length;
  const paused={...input,order:fixture.model.transitionOrder(input.order,{type:'pause',revision:1})};
  assert.equal((await report(await call('recover-prewallet',paused))).restored,true);
  assert.equal((await report(await call('recover-prewallet',pre(full.order.id,true)))).restored,true);
  assert.equal((await report(await call('recover',full))).restored,true);
  assert.equal((await call('send',full,{costApproval:{}})).status,409);assert.equal((await call('check',pre(full.order.id,true))).status,409);assert.equal(fixture.calls.length,before);
  cases.push('SQLite restart and secret rotation restore proof for paused state or late saved partial without RPC and permanently block sends');
  await runtime.stop();await runtime.start();const failed=fixture.signedInput('runtime-prewallet-failed'),lost=pre(failed.order.id,true);await prepare(lost);
  fixture.receipt(failed.response.transactionBase64);fixture.setMode('failure-finalized');assert.equal((await call('recover-prewallet',lost)).status,200);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  const restored=await report(await call('recover-prewallet',lost));assert.equal(restored.restored,true);assert.equal(restored.result.evidence.feeLamports,'10000');
  assert.equal((await call('replace',closeAttempt(fixture,failed,restored.result),{acknowledgedFeeLamports:'10000'})).status,409);assert.equal(fixture.calls.length,before);
  cases.push('lost reply restores paid failure evidence atomically; no retry permission is inferred from the missing wallet history');
  await runtime.stop();await runtime.start();fixture.setMode('normal');const absent=pre('runtime-prewallet-absent');await prepare(absent);
  assert.equal((await report(await call('recover-prewallet',absent))).status,'unknown');
  fixture.receipt(fixture.signedInput(absent.order.id).response.transactionBase64);fixture.setMode('pending');
  assert.equal((await report(await call('recover-prewallet',absent))).status,'unknown');fixture.setMode('normal');
  assert.equal((await report(await call('recover-prewallet',absent))).result.status,'verified');
  cases.push('empty and nonfinalized histories retain uncertainty until exact finalized evidence appears');
  const prior=fixture.signedInput('runtime-prewallet-second');await prepare(prior);fixture.receipt(prior.response.transactionBase64);fixture.setMode('failure-finalized');
  const priorResult=await report(await call('recover',prior)),source=closeAttempt(fixture,prior,priorResult);
  fixture.setMode('normal');fixture.setGeneration(2);const replacement=await report(await call('replace',source,{acknowledgedFeeLamports:'10000'}));
  const partial=replacementPartial(fixture,source,replacement),second=signReplacement(fixture,partial),missing={...partial,request:null};
  fixture.receipt(second.response.transactionBase64);assert.equal((await report(await call('recover-prewallet',missing))).result.proof.slot,1450);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  assert.equal((await report(await call('recover',prior))).evidence.feeLamports,'10000');
  assert.equal((await report(await call('recover-prewallet',missing))).result.status,'verified');assert.equal(fixture.calls.length,before);
  cases.push('second claim uses the genuine acknowledged replacement anchor and preserves both outcomes across SQLite restart');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
