// Disposable protocol fixtures only; no browser, real wallet, live RPC or sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {responseExpiryReplacementSource} from '../orders/response-expiry-replacement.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerResponseRecovery} from '../orders/response-recovery-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const history=prewalletExpiryFixture(f),{makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://response-expiry-replacement-client.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
async function fixture(id){
  history.set(false);history.history();history.rewrite(undefined);f.setGeneration(1);
  const values=new Map();let now=Date.now();
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async transaction(fn){return fn(this);}};
  const gate=new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>f.upstream(new Request(u,i))});
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  const full=f.signedInput(id);await report(await call('prepare',{order:f.model.createOrder({...full.order,available:9999,assets:full.order.items.map(i=>i.asset)})}));
  const checked=await report(await call('check',f.input(id))),approval={version:1,quote:checked.costQuote,maxTotalLamports:checked.costQuote.budget.totalLamports,approvedAt:Date.now()};
  const input=missingResponse(full,approval);history.set();const expired=await report(await call('review-response-expiry',input,{authorizeExpiryReview:true}));
  const closed=f.model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:1,proof:expired.proof});
  const source=responseExpiryReplacementSource(closed,input.claim,expired,input.request,input.walletClaim);history.set(false);f.setGeneration(2);
  return{source,next:await report(await call('replace-response-expiry',source.input,{authorizeReplacement:true}))};
}
test('response replacement HTTPS emits exact actual-wallet schema and rejects altered bindings or safety flags',async()=>{
  const {source,next}=await fixture('response-replacement-transport');
  for(const edit of [undefined,v=>v.walletClaimSha256='0'.repeat(64),v=>v.requestSha256='0'.repeat(64),v=>v.previousSignature='invented',
    v=>v.record.prior.proof.signature='invented',v=>v.record.responseExpiry.walletClaim.claimId='0'.repeat(64),
    v=>v.record.responseExpiry.walletClaim.costApproval.approvedAt--,v=>v.record.responseExpiry.request.transactionBase64='changed',
    v=>v.record.acknowledgedFeeLamports='0',v=>v.candidate.orderRevision++,v=>v.readyToSign=true]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(url,init)=>{
      assert.equal(url,origin+'/api/buyer/replace-response-expiry');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
      const body=JSON.parse(init.body);assert.deepEqual(Object.keys(body).sort(),['authorizeReplacement','claim','nonce','order','request','version','walletClaim']);
      assert.equal(body.authorizeReplacement,true);assert.deepEqual(body.walletClaim,source.input.walletClaim);assert.deepEqual(body.request,source.input.request);
      const value=structuredClone(next);edit?.(value);return Response.json({version:1,nonce:body.nonce,report:value});
    }});
    if(edit)await assert.rejects(transport.replaceResponseExpiry(source.input));else assert.deepEqual(await transport.replaceResponseExpiry(source.input),next);
  }
  const calls=f.calls.length;let sent=0;
  const transport=createBuyerSubmissionTransport({origin,fetchImpl:async()=>{sent++;assert.fail('invalid input must never reach HTTP');}});
  for(const edit of [v=>delete v.walletClaim,v=>v.request=null,v=>v.response={},v=>v.walletClaim.costApproval.maxTotalLamports='1']){
    const value=structuredClone(source.input);edit(value);await assert.rejects(transport.replaceResponseExpiry(value));
  }
  assert.equal(sent,0);assert.equal(f.calls.length,calls);
});
test('response replacement controller requires explicit action and exact retained source, rejects fees and pause before HTTP',async()=>{
  const {source,next}=await fixture('response-replacement-controller');let current=source,calls=0,answer=next;
  const controller=createBuyerResponseRecovery({scope:{id:'scope'},storage:{readBuyerResponseRecovery:async()=>assert.fail('wrong read'),
    saveRecoveredBuyerResponse:async()=>assert.fail('unexpected history write'),readBuyerResponseReplacement:async scope=>{assert.deepEqual(scope,{id:'scope'});return current;}},
    transport:{recoverResponse:async()=>assert.fail('unexpected recovery'),replaceResponseExpiry:async input=>{assert.deepEqual(input,source.input);calls++;return answer;}}});
  await assert.rejects(controller.prepareReplacement(),/EXPLICIT_REPLACEMENT_REQUIRED/);
  for(const fee of ['0','10000',null])await assert.rejects(controller.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:fee}));
  for(const state of [null,{status:'wallet-response-unknown'},{...source,input:{...source.input,order:f.model.transitionOrder(source.input.order,{type:'pause',revision:source.input.order.revision})}}]){
    current=state;await assert.rejects(controller.prepareReplacement({authorizeReplacement:true}),/REPLACEMENT_NOT_READY/);
  }
  assert.equal(calls,0);current=source;assert.deepEqual(await controller.prepareReplacement({authorizeReplacement:true}),next);assert.equal(calls,1);
  answer=structuredClone(next);answer.record.responseExpiry.walletClaim.claimId='0'.repeat(64);await assert.rejects(controller.prepareReplacement({authorizeReplacement:true}));
});
test('one controller cannot overlap replacement with response recovery or expiry review',async()=>{
  const {source,next}=await fixture('response-replacement-busy');let release,reads=0;
  const controller=createBuyerResponseRecovery({scope:{},storage:{readBuyerResponseRecovery:async()=>{reads++;assert.fail('overlapping read');},
    saveRecoveredBuyerResponse:async()=>assert.fail('unexpected history write'),readBuyerResponseReplacement:async()=>source},
    transport:{recoverResponse:async()=>assert.fail('unexpected recovery'),replaceResponseExpiry:async()=>{await new Promise(r=>release=r);return next;}}});
  const pending=controller.prepareReplacement({authorizeReplacement:true});while(!release)await new Promise(r=>setImmediate(r));
  await assert.rejects(controller.prepareReplacement({authorizeReplacement:true}),/BUSY/);
  await assert.rejects(controller.recoverMissingResponse(),/BUSY/);await assert.rejects(controller.reviewExpiry({authorizeExpiryReview:true}),/BUSY/);
  release();assert.deepEqual(await pending,next);assert.equal(reads,0);assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
