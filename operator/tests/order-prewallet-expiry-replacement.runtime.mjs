// Actual workerd/SQLite. External RPC and submissions are intercepted fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime} from './fixtures/buyer-gateway-runtime.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {prewalletExpiryReplacementSource} from '../orders/prewallet-expiry-replacement.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const history=prewalletExpiryFixture(fixture),origin='https://buyer-unsigned-replacement-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-unsigned-replacement-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const replace=input=>call('replace-prewallet-expiry',input,{authorizeReplacement:true});
const review=input=>call('review-prewallet-expiry',input,{authorizeExpiryReview:true});
const pre=(id,native=false)=>({...fixture.input(id),...(!native?{request:null}:{})});
async function expired(id,native=false){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);
  const input=pre(id,native),order=fixture.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
  await report(await call('prepare',{order}));history.set();const retired=await report(await review(input));
  const closed=closeAttempt(fixture,input,retired),source=prewalletExpiryReplacementSource(closed.order,input.claim,retired,input.request);
  history.set(false);fixture.setGeneration(2);return{input,retired,source};
}
try{
  await runtime.start();
  for(const native of [false,true]){
    const {input,retired,source}=await expired('runtime-unsigned-replacement-'+native,native),count=fixture.calls.length;
    assert.equal((await call('replace-prewallet-expiry',source.input)).status,400);
    assert.equal((await call('replace-prewallet-expiry',source.input,{authorizeReplacement:true,acknowledgedFeeLamports:'0'})).status,400);
    const paused={...source.input,order:fixture.model.transitionOrder(source.input.order,{type:'pause',revision:2})};
    assert.equal((await replace(paused)).status,400);assert.equal(fixture.calls.length,count);
    assert.equal((await replace(source.input)).status,200); // Drop the HTTP reply after SQLite commit.
    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const before=fixture.calls.length;
    const next=await report(await replace(source.input));assert.equal(next.restored,true);assert.equal(next.record.version,4);
    assert.equal(next.record.prior.proof.signature,null);assert.deepEqual(next.record.prior.proof,retired.proof);
    const full=fixture.signedInput(input.order.id);
    for(const [route,value,extra]of [['check',pre(input.order.id,true),{}],['send',full,{costApproval:{}}],['recover-prewallet',input,{}],['recover',full,{}]])assert.equal((await call(route,value,extra)).status,409);
    assert.equal(fixture.calls.length,before);
    cases.push(native?'saved partial receives one replacement with the actual unsigned expiry and no fabricated fee or buyer signature':'missing native result replacement survives discarded HTTP reply, full SQLite restart and credential rotation without RPC');
    await runtime.stop();await runtime.start();
    const partial=replacementPartial(fixture,source.input,next);assert.equal(partial.claim.orderRevision,3);
    if(native){
      history.history([1550,1199]);history.set();const second={...partial,request:null},secondExpiry=await report(await review(second));
      assert.equal(secondExpiry.evidence.anchorSlot,1200);assert.equal(secondExpiry.proof.signature,null);
      await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const saved=fixture.calls.length;
      assert.equal((await report(await review(second))).restored,true);assert.equal((await report(await review(input))).restored,true);
      assert.equal((await replace(closeAttempt(fixture,second,secondExpiry))).status,400);assert.equal((await call('check',partial)).status,409);
      assert.equal(fixture.calls.length,saved);
      cases.push('second unsigned expiry uses its own replacement anchor, preserves both proofs after restart and never permits a third attempt');
    }else{
      const checked=await report(await call('check',partial)),second=signReplacement(fixture,partial);
      const quote=checked.costQuote,approval={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
      assert.equal((await call('send',second,{costApproval:{}})).status,409);
      assert.equal((await report(await call('send',second,{costApproval:approval}))).status,'accepted');
      const recovered=await report(await call('recover',second));assert.equal(recovered.status,'verified');
      await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});const saved=fixture.calls.length;
      assert.equal((await call('send',second,{costApproval:approval})).status,409);
      assert.equal((await report(await review(input))).restored,true);assert.equal(fixture.calls.length,saved);
      cases.push('second claim requires a newly saved quote and consent; one intercepted submission verifies while restart keeps both old sends closed');
    }
    await runtime.stop();await runtime.start();
  }
  const {source}=await expired('runtime-unsigned-replacement-observed');
  const underlying=fixture.upstream;fixture.upstream=async(req,ResponseType=Response)=>{
    const c=await req.clone().json(),r=await underlying(req,ResponseType);if(c.method!=='getMultipleAccounts'||c.params[0].length!==1)return r;
    const b=await r.json();b.result.value=[{lamports:1}];return new ResponseType(JSON.stringify(b),{headers:{'content-type':'application/json'}});
  };
  assert.equal((await replace(source.input)).status,409);fixture.upstream=underlying;
  cases.push('an asset that reappears after unsigned expiry prevents replacement preparation in actual workerd');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,1);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:1,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
