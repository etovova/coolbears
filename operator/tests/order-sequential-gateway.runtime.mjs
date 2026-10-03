// Actual workerd/SQLite; exact Core receipts and one sender acknowledgment are local fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {sequentialGatewayFixture} from './fixtures/buyer-sequential.mjs';
import {buyerStorageRuntime} from './fixtures/buyer-storage-runtime.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {costQuoteKey,validateCostApproval} from '../orders/cost-approval.mjs';
import {verifyBuyerSigningResponse} from '../orders/signing.mjs';
import {validateBuyerResult,signedBytesId} from '../orders/submission.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const h=sequentialGatewayFixture(f,{quantity:2,prefix:1,prepared:true,redeemed:9998,allowFixtureSubmission:true}),fixture=h.fixture;
const origin='https://buyer-sequential-runtime.test',persist=await mkdtemp(path.join(tmpdir(),'coolbears-sequential-gateway-'));
const runtime=await buyerStorageRuntime({fixture,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(resolve=>setTimeout(resolve,250));return runtime.dispatch(origin+'/api/buyer/'+route,
  {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const report=async response=>{assert.equal(response.status,200,await response.clone().text());return(await response.json()).report;};
const partial={order:h.read(),claim:h.input.claim,request:h.input.request};
try{
  await runtime.start();let before=fixture.calls.length;
  const prepared=await report(await call('prepare',{order:h.readyOrder}));assert.equal(prepared.candidate.itemIndex,1);
  assert.equal(prepared.candidate.orderRevision,h.readyOrder.revision);assert.equal(prepared.restored,false);
  assert.equal((await runtime.storage('get',anchorKey(h.readyOrder,1,1))).present,true);
  assert.equal((await runtime.storage('get',anchorKey(h.readyOrder,1,0))).present,false);
  assert.equal(fixture.calls.slice(before).filter(c=>c.method==='getTransaction').length,1);
  assert.equal(fixture.calls.slice(before).filter(c=>c.method==='getSignatureStatuses').length,1);
  cases.push('actual SQLite prepares item 2 only after exact finalized prefix receipt and Core account verification, using an item-bound anchor');

  await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=fixture.calls.length;
  const restored=await report(await call('prepare',{order:h.readyOrder}));assert.equal(restored.restored,true);
  assert.deepEqual(restored.anchor,prepared.anchor);assert.deepEqual(restored.candidate,prepared.candidate);assert.equal(fixture.calls.length,before);
  const check=await report(await call('check',partial));assert.equal(check.status,'wallet-check-passed');assert.equal(check.itemIndex,1);
  assert.equal(check.itemsRemaining,1);assert.equal(check.budget.remainingQuantity,1);assert.equal(check.budget.completedQuantity,1);
  assert.equal(check.costQuote.version,2);assert.equal(check.costQuote.budget.remainingQuantity,1);
  assert.deepEqual((await runtime.storage('get',costQuoteKey(check.costQuote.quoteId))).value,check.costQuote);
  cases.push('lost preparation reply and process restart restore identical bytes without RPC; current item receives a fresh v2 cost quote for one remaining asset');

  const tx=VersionedTransaction.deserialize(Buffer.from(partial.request.transactionBase64,'base64'));tx.sign([f.owner]);
  const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')},signed=verifyBuyerSigningResponse(partial.order,partial.claim,partial.request,response);
  let order=f.model.transitionOrder(partial.order,{type:'unknown',revision:partial.order.revision,index:1,attempt:1});
  order=f.model.transitionOrder(order,{type:'signature',revision:order.revision,index:1,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  const full={...partial,order,response},oldApproval=f.costApproval(f.input(partial.order.id,2));before=fixture.calls.length;
  const refused=await call('send',full,{costApproval:oldApproval});assert.equal(refused.status,409,await refused.clone().text());assert.equal(fixture.calls.length,before);
  const approval={version:1,quote:check.costQuote,maxTotalLamports:check.costQuote.budget.totalLamports,approvedAt:Date.now()};
  validateCostApproval(approval,full,{now:Date.now()});
  cases.push('item 1 cost consent cannot authorize item 2; the new quote and explicit cap bind the current exact bytes before any sender claim or RPC');

  const sendKey=index=>'buyer-send:v1:'+signedBytesId(JSON.stringify([order.cluster,order.machine,order.collection,order.guard,order.buyer,order.items[index].asset]));
  const firstSend=await runtime.storage('get',sendKey(0));assert.equal(firstSend.present,false);
  h.expectFixtureSubmission(full);before=fixture.calls.length;
  const accepted=await report(await call('send',full,{costApproval:approval}));validateBuyerResult(accepted,full);
  assert.equal(accepted.status,'accepted');assert.equal(accepted.costQuoteId,approval.quote.quoteId);assert.equal(accepted.checkedTotalLamports,approval.quote.budget.totalLamports);
  assert.equal(fixture.fixtureSubmissions,1);const sent=fixture.calls.slice(before).filter(c=>c.method==='sendTransaction');
  assert.equal(sent.length,1);assert.equal(sent[0].params[0],full.response.transactionBase64);
  assert.deepEqual(await runtime.storage('get',sendKey(0)),firstSend);
  const claimed=(await runtime.storage('get',sendKey(1))).value;
  assert.equal(claimed.signature,signed.signature);assert.deepEqual(claimed.costApproval,approval);
  before=fixture.calls.length;const replay=await call('send',full,{costApproval:approval});
  assert.equal(replay.status,409);assert.equal((await replay.json()).code,'SEND_ALREADY_CLAIMED');
  assert.equal(fixture.calls.length,before);assert.equal(fixture.fixtureSubmissions,1);
  cases.push('fresh item 2 consent passes signed preflight and exactly one local sender acknowledgment; item 1 send key stays untouched and replay fails before another fixture send');

  h.observe(full);h.set(order);const recovered=await report(await call('recover',full));assert.equal(recovered.status,'verified');
  assert.equal(recovered.proof.asset,order.items[1].asset);validateBuyerResult(recovered,full,{recovery:true});
  const completed=f.model.transitionOrder(order,{type:'reconcile',revision:order.revision,index:1,attempt:1,proof:recovered.proof});
  assert.equal(f.model.nextAction(completed).type,'complete');assert.deepEqual(completed.items[0],h.readyOrder.items[0]);
  assert.equal((await call('prepare',{order:completed})).status,400);
  cases.push('read-only recovery verifies an externally observed second Core mint and reaches complete without changing item 1 evidence or submitting a transaction');

  const ledgerKey='buyer-check-budget:v1',ledger=(await runtime.storage('get',ledgerKey)).value;
  await runtime.storage('put',ledgerKey,{...ledger,checks:100,nextAt:0,holdUntil:0,cooldownUntil:0});
  const next=sequentialGatewayFixture(f,{quantity:3,prefix:2,redeemed:9998});before=fixture.calls.length;
  const blocked=await call('prepare',{order:next.readyOrder});assert.equal(blocked.status,429);assert.equal((await blocked.json()).code,'DAILY_LIMIT');
  assert.equal(fixture.calls.length,before);assert.equal((await runtime.storage('get',anchorKey(next.readyOrder,1,2))).present,false);
  assert.deepEqual((await runtime.storage('get',anchorKey(h.readyOrder,1,1))).value,{anchor:prepared.anchor,candidate:prepared.candidate});
  cases.push('existing daily check quota stops the next item before RPC or new anchor persistence while preserving prior item evidence and anchors');

  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);
  assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,1);assert.equal(fixture.fixtureSubmissions,1);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,fixtureSubmissions:fixture.fixtureSubmissions,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
