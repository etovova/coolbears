// Actual workerd/SQLite. All keys, history and RPC are disposable fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerStorageRuntime} from './fixtures/buyer-storage-runtime.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {responseExpiryReplacementSource} from '../orders/response-expiry-replacement.mjs';
import {responseExpiryKey} from '../orders/response-expiry.mjs';
import {prewalletExpiryKey} from '../orders/prewallet-expiry.mjs';
import {responseRecoveryKey} from '../orders/response-recovery.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {costQuoteKey} from '../orders/cost-approval.mjs';
import {replacementKey,validateReplacementResult} from '../orders/replacement.mjs';
import {signedBytesId} from '../orders/submission.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const history=prewalletExpiryFixture(fixture),origin='https://buyer-response-replacement-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-response-replacement-runtime-'));
const runtime=await buyerStorageRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(resolve=>setTimeout(resolve,250));return runtime.dispatch(origin+'/api/buyer/'+route,
  {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const report=async response=>{assert.equal(response.status,200,await response.clone().text());return(await response.json()).report;};
const replace=input=>call('replace-response-expiry',input,{authorizeReplacement:true});
const review=input=>call('review-response-expiry',input,{authorizeExpiryReview:true});
const approval=quote=>({version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()});
const transition=(order,type)=>fixture.model.transitionOrder(order,{type,revision:order.revision});
async function expired(id){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);
  const full=fixture.signedInput(id),initial=fixture.model.createOrder({...full.order,available:9999,assets:full.order.items.map(item=>item.asset)});
  await report(await call('prepare',{order:initial}));
  const costApproval=approval((await report(await call('check',fixture.input(id)))).costQuote),input=missingResponse(full,costApproval);
  history.set();const retired=await report(await review(input));assert.equal(retired.status,'response-expired');
  const closed=closeAttempt(fixture,input,retired),source=responseExpiryReplacementSource(closed.order,input.claim,retired,input.request,input.walletClaim);
  history.set(false);fixture.setGeneration(2);return{full,input,retired,source,costApproval};
}
async function deniedWithoutRpc(input,status=409){
  const before=fixture.calls.length,response=await replace(input);assert.equal(response.status,status,await response.clone().text());
  assert.equal(fixture.calls.length,before);
}
async function temporaryRecord(key,value,check){
  const saved=await runtime.storage('get',key);
  await runtime.storage(value===undefined?'delete':'put',key,value);
  try{await check();}finally{await runtime.storage(saved.present?'put':'delete',key,saved.value);}
}
try{
  await runtime.start();const first=await expired('runtime-response-replacement'),original=structuredClone(first.input);
  let before=fixture.calls.length;
  for(const extra of [{},{authorizeReplacement:false},{authorizeReplacement:true,acknowledgedFeeLamports:'0'},{authorizeReplacement:true,response:first.full.response}])
    assert.equal((await call('replace-response-expiry',first.source.input,extra)).status,400);
  const paused={...first.source.input,order:transition(first.source.input.order,'pause')};await deniedWithoutRpc(paused,400);
  const changed=structuredClone(first.source.input);changed.walletClaim.costApproval.approvedAt++;await deniedWithoutRpc(changed);
  assert.equal(fixture.calls.length,before);
  assert.equal((await replace(first.source.input)).status,200); // Drop the HTTP acknowledgment after the SQLite commit.
  const saved=(await runtime.storage('get',replacementKey(first.input.order))).value;
  assert.equal(saved.version,5);assert.equal(saved.prior.proof.signature,null);assert.deepEqual(saved.prior,first.source.expiryRecord);
  assert.deepEqual(saved.responseExpiry,{request:first.input.request,walletClaim:first.input.walletClaim});
  assert.equal(saved.acknowledgedFeeLamports,undefined);assert.notEqual(saved.anchor.blockhash,first.input.claim.blockhash);
  assert.ok(saved.anchor.lastValidBlockHeight>first.retired.proof.blockHeight+80);
  const issued=fixture.calls.slice(before),account=issued.find(call=>call.method==='getMultipleAccounts'),latest=issued.find(call=>call.method==='getLatestBlockhash');
  assert.equal(account.params[1].commitment,'finalized');assert.ok(account.params[1].minContextSlot>=first.retired.proof.accountSlot);
  assert.ok(latest.params[0].minContextSlot>=1100);assert.equal(saved.anchor.sourceSlot,1200);
  assert.deepEqual(first.input,original);
  cases.push('only explicit missing-response replacement accepts the genuine wallet and cost claim; retained null-signature expiry precedes a distinct conservative hash and v5 SQLite record');

  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  const restored=await report(await replace(first.source.input));validateReplacementResult(restored,first.source.input);
  assert.equal(restored.restored,true);assert.deepEqual(restored.record,saved);assert.equal(restored.previousSignature,null);
  assert.equal(restored.walletClaimSha256,signedBytesId(JSON.stringify(first.input.walletClaim)));
  assert.equal(restored.signaturesCreated,0);assert.equal(restored.transactionsSent,0);assert.equal(restored.readyToSign,false);
  assert.equal(restored.readyToSubmit,false);assert.equal(restored.salesOpen,false);
  await deniedWithoutRpc(paused,400);
  const resumed={...first.source.input,order:transition(paused.order,'resume')},rebound=await report(await replace(resumed));
  validateReplacementResult(rebound,resumed);assert.deepEqual(rebound.record,saved);assert.equal(rebound.orderRevision,resumed.order.revision);
  assert.equal(rebound.candidate.orderRevision,resumed.order.revision);assert.equal(rebound.restored,true);
  assert.equal((await review(first.input)).status,409);
  assert.deepEqual((await runtime.storage('get',responseExpiryKey(first.input.order))).value,first.source.expiryRecord);
  for(const [route,input,extra]of [
    ['check',fixture.input(first.input.order.id),{}],['send',first.full,{costApproval:first.costApproval}],
    ['recover-response',first.input,{}],['recover',first.full,{}],
    ['replace',closeAttempt(fixture,first.full,{proof:{...first.retired.proof,signature:first.full.order.items[0].attempts[0].signature}}),{authorizeReplacement:true}],
  ])assert.equal((await call(route,input,extra)).status,409,route);
  assert.equal(fixture.calls.length,before);
  cases.push('lost HTTP reply, full SQLite restart and credential rotation restore identical bytes without RPC; pause denies creation and resume rebinds only the current revision while old sends stay closed');

  const key=responseExpiryKey(first.input.order),corrupt=structuredClone(first.source.expiryRecord);corrupt.identity.walletClaimSha256='d'.repeat(64);
  const originalAnchor=(await runtime.storage('get',anchorKey(first.input.order))).value,badOriginalAnchor=structuredClone(originalAnchor);
  badOriginalAnchor.anchor.sourceSlot++;
  const quoteKey=costQuoteKey(first.costApproval.quote.quoteId),badQuote=structuredClone(first.costApproval.quote);badQuote.issuedAt++;
  await temporaryRecord(key,undefined,()=>deniedWithoutRpc(first.source.input));
  await temporaryRecord(key,corrupt,()=>deniedWithoutRpc(first.source.input));
  for(const [storedKey,value]of [[anchorKey(first.input.order),undefined],[anchorKey(first.input.order),badOriginalAnchor],[quoteKey,undefined],[quoteKey,badQuote]])
    await temporaryRecord(storedKey,value,()=>deniedWithoutRpc(first.source.input));
  for(const conflict of [prewalletExpiryKey(first.input.order),responseRecoveryKey(first.input.order)])
    await temporaryRecord(conflict,{version:1},()=>deniedWithoutRpc(first.source.input));
  const broken=structuredClone(saved);broken.responseExpiry.walletClaim.costApproval.approvedAt++;
  await temporaryRecord(replacementKey(first.input.order),broken,()=>deniedWithoutRpc(first.source.input));
  const partial=replacementPartial(fixture,resumed,rebound);
  for(const mutate of [
    ()=>temporaryRecord(key,undefined,async()=>assert.equal((await call('check',partial)).status,409)),
    ()=>temporaryRecord(key,corrupt,async()=>assert.equal((await call('check',partial)).status,409)),
    ()=>temporaryRecord(responseRecoveryKey(first.input.order),{version:1},async()=>assert.equal((await call('check',partial)).status,409)),
    ()=>temporaryRecord(replacementKey(first.input.order),broken,async()=>assert.equal((await call('check',partial)).status,409)),
    ...[[anchorKey(first.input.order),undefined],[anchorKey(first.input.order),badOriginalAnchor],[quoteKey,undefined],[quoteKey,badQuote]].map(([storedKey,value])=>
      ()=>temporaryRecord(storedKey,value,async()=>assert.equal((await call('check',partial)).status,409))),
  ])await mutate();
  assert.equal(fixture.calls.length,before);
  cases.push('missing or altered durable expiry, original anchor or cost quote, conflicting response/prewallet records and corrupt v5 wallet consent deny both cached replacement and second checks before RPC');

  await runtime.stop();await runtime.start();const secondFull=signReplacement(fixture,partial);before=fixture.calls.length;
  assert.equal((await call('send',secondFull,{costApproval:first.costApproval})).status,409);assert.equal(fixture.calls.length,before);
  const nextApproval=approval((await report(await call('check',partial))).costQuote);
  assert.notEqual(nextApproval.quote.requestId,first.costApproval.quote.requestId);
  const second=missingResponse(secondFull,nextApproval);history.history([1550,1199]);history.set();
  const ended=await report(await review(second));assert.equal(ended.status,'response-expired');assert.equal(ended.evidence.anchorSlot,1200);
  assert.equal(ended.evidence.lastValidBlockHeight,2600);assert.equal(ended.proof.signature,null);
  assert.deepEqual(second.order.items[0].attempts[0].proof,first.retired.proof);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  const endAgain=await report(await review(second));assert.equal(endAgain.restored,true);assert.deepEqual(endAgain.proof,ended.proof);
  assert.equal((await review(first.input)).status,409);
  assert.deepEqual((await runtime.storage('get',responseExpiryKey(first.input.order))).value,first.source.expiryRecord);
  const third=closeAttempt(fixture,second,ended);await deniedWithoutRpc(third,400);
  assert.equal((await call('send',secondFull,{costApproval:nextApproval})).status,409);
  assert.equal((await call('check',partial)).status,409);
  assert.equal(fixture.calls.length,before);
  cases.push('attempt two needs new cost consent and its own anchor; a second missing response expires durably, preserves both terminal proofs and denies third attempts after restart without any send');

  await runtime.stop();await runtime.start();const missing=await expired('runtime-response-replacement-missing-anchor');before=fixture.calls.length;
  await temporaryRecord(responseExpiryKey(missing.input.order),undefined,()=>deniedWithoutRpc(missing.source.input));
  await temporaryRecord(anchorKey(missing.input.order),undefined,()=>deniedWithoutRpc(missing.source.input));
  const anchor=(await runtime.storage('get',anchorKey(missing.input.order))).value,badAnchor=structuredClone(anchor);badAnchor.anchor.sourceSlot++;
  await temporaryRecord(anchorKey(missing.input.order),badAnchor,()=>deniedWithoutRpc(missing.source.input));
  assert.equal(fixture.calls.length,before);
  cases.push('a structurally valid browser retirement cannot create a replacement without the matching durable expiry and original blockhash anchor');

  const upstream=fixture.upstream;fixture.upstream=async(request,ResponseType=Response)=>{
    const input=await request.clone().json(),response=await upstream(request,ResponseType);
    if(input.method!=='getMultipleAccounts'||input.params[0].length!==1)return response;
    const body=await response.json();body.result.value=[{lamports:1}];return new ResponseType(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  };
  assert.equal((await replace(missing.source.input)).status,409);fixture.upstream=upstream;
  assert.equal((await runtime.storage('get',replacementKey(missing.input.order))).present,false);
  cases.push('an asset observed again after response expiry prevents replacement persistence in actual workerd');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  assert.equal(fixture.calls.filter(call=>call.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
