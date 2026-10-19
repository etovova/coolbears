// Actual workerd/SQLite with disposable keys and fully intercepted external RPC.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime} from './fixtures/buyer-gateway-runtime.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {validateResponseExpiry} from '../orders/response-expiry.mjs';
import {validateBuyerExpiryResult} from '../orders/expiry-review.mjs';
import {signedBytesId} from '../orders/submission.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true});approved.owner=fixture.policy.owner;
const history=prewalletExpiryFixture(fixture),origin='https://buyer-response-expiry-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-response-expiry-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(r=>setTimeout(r,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const review=input=>call('review-response-expiry',input,{authorizeExpiryReview:true});
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const approval=quote=>({version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()});
async function prepare(full){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);
  await report(await call('prepare',{order:fixture.model.createOrder({...full.order,available:9999,assets:full.order.items.map(i=>i.asset)})}));
  return approval((await report(await call('check',fixture.input(full.order.id)))).costQuote);
}
function assertRetired(value,input,transactions=2){
  validateResponseExpiry(value,input);assert.equal(value.status,'response-expired');assert.equal(value.proof.signature,null);
  assert.equal(value.evidence.historyTransactions,transactions);assert.equal(value.walletClaimSha256,signedBytesId(JSON.stringify(input.walletClaim)));
  assert.equal(value.response,undefined);assert.equal(value.result,undefined);assert.equal(value.retryAuthorized,false);
  assert.equal(value.readyToSubmit,false);assert.equal(value.salesOpen,false);assert.equal(value.transactionsSent,0);
}
try{
  await runtime.start();const full=fixture.signedInput('runtime-response-expiry'),costApproval=await prepare(full);
  const input=missingResponse(full,costApproval),original=structuredClone(input);history.set();
  assert.equal((await review(input)).status,200); // Deliberately discard the committed HTTP reply.
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});let count=fixture.calls.length;
  const retired=await report(await review(input));assertRetired(retired,input);assert.equal(retired.restored,true);assert.equal(retired.networkRequests,0);
  assert.deepEqual(input,original);assert.equal(input.order.items[0].attempts[0].signature,null);
  const paused={...input,order:fixture.model.transitionOrder(input.order,{type:'pause',revision:input.order.revision})};
  const restored=await report(await review(paused));assertRetired(restored,paused);assert.equal(restored.restored,true);
  for(const edit of [v=>v.walletClaim.claimId='d'.repeat(64),v=>v.walletClaim.costApproval.approvedAt++]){
    const changed=structuredClone(input);edit(changed);assert.equal((await review(changed)).status,409);
  }
  const closed=closeAttempt(fixture,input,retired),native=fixture.input(full.order.id);
  for(const [route,value,extra]of [
    ['check',native,{}],['send',full,{costApproval}],['recover',full,{}],['recover-response',input,{}],
    ['recover-prewallet',{...native,request:null},{}],
    ['review-prewallet-expiry',{...native,request:null},{authorizeExpiryReview:true}],
  ])assert.equal((await call(route,value,extra)).status,409,route);
  assert.equal((await call('replace',{...full,order:closed.order},{authorizeReplacement:true})).status,400);
  const late=await report(await call('review-expiry',full,{authorizeExpiryReview:true}));validateBuyerExpiryResult(late,full);
  assert.equal(late.status,'expired');assert.equal(late.restored,true);assert.equal(late.networkRequests,0);
  assert.equal(late.proof.signature,full.order.items[0].attempts[0].signature);
  assert.equal((await call('replace',closeAttempt(fixture,full,late),{authorizeReplacement:true})).status,409);
  assert.deepEqual((await report(await review(input))).proof,retired.proof);
  assert.equal(fixture.calls.length,count);
  cases.push('lost HTTP reply, SQLite restart, credential rotation and pause restore one terminal retirement without RPC; real claim and cost consent remain bound with no invented buyer signature or replacement grant');
  cases.push('late signed response cannot reopen old check, send or recovery; explicit signed-expiry convergence uses only its genuine signature, keeps the null-signature retirement intact and cannot grant replacement');

  await runtime.stop();await runtime.start();const unknownFull=fixture.signedInput('runtime-response-expiry-unknown');
  const unknown=missingResponse(unknownFull,await prepare(unknownFull));history.set();
  for(const slots of [[],[850],Array.from({length:20},(_,i)=>850-i)]){
    history.history(slots);const value=await report(await review(unknown));validateResponseExpiry(value,unknown);
    assert.equal(value.status,'unknown');assert.equal(value.proof,undefined);assert.equal(value.evidence,undefined);assert.equal(value.retryAuthorized,false);
  }
  history.history();
  for(const edit of [
    (c,b)=>{if(c.method==='getFirstAvailableBlock')b.result=601;},
    (c,b)=>{if(c.method==='getTransaction')b.result=null;},
    (c,b)=>{if(c.method==='getTransaction'){const tx=VersionedTransaction.deserialize(Buffer.from(b.result.transaction[0],'base64'));tx.signatures[0][0]^=1;b.result.transaction[0]=Buffer.from(tx.serialize()).toString('base64');}},
  ]){
    history.rewrite(edit);const value=await report(await review(unknown));validateResponseExpiry(value,unknown);
    assert.equal(value.status,'unknown');assert.equal(value.proof,undefined);assert.equal(value.evidence,undefined);assert.equal(value.response,undefined);
  }
  history.rewrite(undefined);history.history([...Array.from({length:10},(_,i)=>850-i),599]);
  const complete=await report(await review(unknown));assertRetired(complete,unknown,11);assert.equal(complete.evidence.historyPages,2);
  cases.push('empty, truncated, capped, pruned, missing-byte and invalid-signature history stay unknown; a complete second page subsequently proves bounded finalized absence');

  for(const kind of ['response','failure','send']){
    const competing=fixture.signedInput('runtime-response-expiry-conflict-'+kind),consent=await prepare(competing);
    const missing=missingResponse(competing,consent);
    if(kind==='send'){
      fixture.setMode('simulation');assert.equal((await call('send',competing,{costApproval:consent})).status,409);
    }else{
      fixture.receipt(competing.response.transactionBase64);
      if(kind==='failure')fixture.setMode('failure-finalized');
      const result=await report(await call(kind==='response'?'recover-response':'recover',kind==='response'?missing:competing));
      assert.equal(result.status,kind==='response'?'response-recovered':'failed');
    }
    history.set();count=fixture.calls.length;assert.equal((await review(missing)).status,409);assert.equal(fixture.calls.length,count);
    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});
    assert.equal((await review(missing)).status,409);assert.equal(fixture.calls.length,count);
    await runtime.stop();await runtime.start();
  }
  cases.push('persisted discovered response, paid failure proof and consumed send marker each block expiry before RPC across SQLite restart; the marker uses a rejected fixture simulation with no submission');

  const first=fixture.signedInput('runtime-response-expiry-second');await prepare(first);
  fixture.receipt(first.response.transactionBase64);fixture.setMode('failure-finalized');
  const failure=await report(await call('recover',first)),source=closeAttempt(fixture,first,failure);
  history.set(false);fixture.setGeneration(2);
  const replacement=await report(await call('replace',source,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  const partial=replacementPartial(fixture,source,replacement),secondApproval=approval((await report(await call('check',partial))).costQuote);
  const secondFull=signReplacement(fixture,partial),second=missingResponse(secondFull,secondApproval);
  history.history([1550,1199]);history.set();const secondRetired=await report(await review(second));assertRetired(secondRetired,second);
  assert.equal(secondRetired.evidence.anchorSlot,1200);assert.equal(secondRetired.evidence.lastValidBlockHeight,2600);
  assert.deepEqual(second.order.items[0].attempts[0].proof,failure.proof);
  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});count=fixture.calls.length;
  assert.equal((await report(await review(second))).restored,true);
  const prior=await report(await call('recover',first));assert.equal(prior.status,'failed');assert.equal(prior.evidence.feeLamports,'10000');
  assert.deepEqual(prior.proof,failure.proof);
  for(const [route,value,extra]of [['check',partial,{}],['send',secondFull,{costApproval:secondApproval}],['recover',secondFull,{}],['recover-response',second,{}]])
    assert.equal((await call(route,value,extra)).status,409,route);
  assert.equal(fixture.calls.length,count);
  cases.push('second attempt uses its genuine replacement anchor and new consent, retains the first paid fee proof after restart and stays permanently closed to late signed bytes');
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
