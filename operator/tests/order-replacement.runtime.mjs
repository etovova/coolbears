// Actual workerd + SQLite, disposable signatures and intercepted RPC only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime} from './fixtures/buyer-gateway-runtime.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const origin='https://buyer-replacement-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-replacement-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const spaced=()=>new Promise(r=>setTimeout(r,250));
const call=async(route,input,extra={})=>{await spaced();return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra,...(route==='replace'?{authorizeReplacement:true}:route==='review-expiry'?{authorizeExpiryReview:true}:{})})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const cost=r=>({version:1,quote:r.costQuote,maxTotalLamports:r.costQuote.budget.totalLamports,approvedAt:Date.now()});
async function expired(id){
  fixture.setGeneration(1);fixture.setMode('normal');const first=fixture.signedInput(id);
  const order=fixture.model.createOrder({...first.order,available:9999,assets:first.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));const approval=cost(await report(await call('check',fixture.input(id))));
  fixture.setMode('fee-rise');assert.equal((await call('send',first,{costApproval:approval})).status,409);
  fixture.setMode('expiry-clear');const proof=await report(await call('review-expiry',first));assert.equal(proof.status,'expired');
  fixture.setGeneration(2);fixture.setMode('normal');return{first,source:closeAttempt(fixture,first,proof),approval};
}
try{
  await runtime.start();const {first,source,approval}=await expired('runtime-replacement');
  const prepared=await report(await call('replace',source));assert.equal(prepared.restored,false);
  cases.push('retained first expiry authorizes one unsigned replacement after a consumed cost-rejected send');
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const before=fixture.calls.length;
  const restored=await report(await call('replace',source));assert.equal(restored.restored,true);assert.deepEqual(restored.record,prepared.record);
  assert.equal(fixture.calls.length,before);cases.push('SQLite replacement survives full runtime restart and credential rotation without another hash request');
  await runtime.stop();await runtime.start();const partial=replacementPartial(fixture,source,restored),second=signReplacement(fixture,partial);
  assert.equal((await call('send',second,{costApproval:approval})).status,409);assert.equal(fixture.calls.length,before);
  const fresh=cost(await report(await call('check',partial)));assert.notEqual(fresh.quote.requestId,approval.quote.requestId);
  cases.push('old cost approval cannot authorize second bytes; fresh persisted quote is bound to attempt two');
  await runtime.stop();await runtime.start();assert.equal((await report(await call('send',second,{costApproval:fresh}))).status,'accepted');
  await runtime.stop();await runtime.start();const sent=fixture.calls.filter(c=>c.method==='sendTransaction').length;
  assert.equal((await call('send',second,{costApproval:fresh})).status,409);assert.equal((await call('send',first,{costApproval:approval})).status,409);
  assert.equal((await report(await call('recover',second))).status,'verified');assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,sent);
  cases.push('both permanent claims survive restart; second finalized receipt and Core asset recover without resend');
  const next=await expired('runtime-replacement-expiry'),again=await report(await call('replace',next.source));
  const unsent=signReplacement(fixture,replacementPartial(fixture,next.source,again));fixture.setMode('expiry-clear');
  const ended=await report(await call('review-expiry',unsent));assert.equal(ended.status,'expired');assert.equal(ended.evidence.anchorSlot,1200);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const endedCalls=fixture.calls.length;
  assert.equal((await report(await call('review-expiry',unsent))).restored,true);
  assert.equal((await call('replace',closeAttempt(fixture,unsent,ended))).status,400);
  assert.equal((await call('send',unsent,{costApproval:{}})).status,409);assert.equal(fixture.calls.length,endedCalls);
  cases.push('second expiry uses its original replacement anchor and persists a separate tombstone; no third attempt');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:sent,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
