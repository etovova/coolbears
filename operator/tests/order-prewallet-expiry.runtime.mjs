import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime} from './fixtures/buyer-gateway-runtime.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {closeAttempt,replacementPartial} from './fixtures/buyer-replacement.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const history=prewalletExpiryFixture(fixture),origin='https://buyer-prewallet-expiry-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-prewallet-expiry-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const review=input=>call('review-prewallet-expiry',input,{authorizeExpiryReview:true});
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const pre=(id,native=false)=>({...fixture.input(id),...(!native?{request:null}:{})});
async function prepare(input){history.set(false);await report(await call('prepare',{order:fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)})}));history.history();history.set();}
try{
  await runtime.start();const input=pre('runtime-unsigned-expiry');await prepare(input);
  const result=await report(await review(input));assert.equal(result.status,'prewallet-expired');assert.equal(result.proof.signature,null);assert.equal(result.evidence.historyTransactions,2);
  cases.push('missing native result closes with finalized lifetime and cryptographically inspected complete payer history; no invented buyer signature');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});let count=fixture.calls.length;
  const paused={...input,order:fixture.model.transitionOrder(input.order,{type:'pause',revision:1})};
  assert.equal((await report(await review(paused))).restored,true);assert.equal((await report(await review(pre(input.order.id,true)))).restored,true);
  const full=fixture.signedInput(input.order.id);
  for(const [route,value,extra]of [['check',pre(input.order.id,true),{}],['recover-prewallet',input,{}],['recover',full,{}],['send',full,{costApproval:{}}]])assert.equal((await call(route,value,extra)).status,409);
  assert.equal(fixture.calls.length,count);
  cases.push('lost reply, SQLite restart, secret rotation, pause and late partial restore one record without RPC; old checker, recovery and sender stay closed');
  await runtime.stop();await runtime.start();const unknown=pre('runtime-unsigned-unknown');await prepare(unknown);history.history([]);
  assert.equal((await report(await review(unknown))).status,'unknown');history.history([850]);assert.equal((await report(await review(unknown))).status,'unknown');
  history.history([...Array.from({length:10},(_,i)=>850-i),599]);assert.equal((await report(await review(unknown))).evidence.historyPages,2);
  cases.push('empty and truncated history cannot retire; a complete second page subsequently supplies the missing boundary');
  history.set(false);const first=fixture.signedInput('runtime-expiry-second');await prepare(first);history.set(false);
  fixture.receipt(first.response.transactionBase64);fixture.setMode('failure-finalized');const failure=await report(await call('recover',first)),source=closeAttempt(fixture,first,failure);
  fixture.setMode('normal');fixture.setGeneration(2);
  const replacement=await report(await call('replace',source,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  const partial=replacementPartial(fixture,source,replacement),second={...partial,request:null};history.history([1550,1199]);history.set();
  const retired=await report(await review(second));assert.equal(retired.proof.signature,null);assert.equal(retired.evidence.anchorSlot,1200);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});count=fixture.calls.length;
  assert.equal((await report(await review(second))).restored,true);assert.equal((await report(await call('recover',first))).evidence.feeLamports,'10000');assert.equal(fixture.calls.length,count);
  cases.push('second attempt requires the genuine replacement anchor and preserves the first paid failure across durable restart');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
