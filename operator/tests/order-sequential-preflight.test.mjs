// Synthetic exact Core mint receipts and accounts; no live RPC, wallet or send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {VersionedTransaction} from '@solana/web3.js';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {sequentialGatewayFixture,sequentialAssetAccount as account} from './fixtures/buyer-sequential.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const harness=options=>sequentialGatewayFixture(f,options);

test('item 2 checks exact finalized prefix and quotes remaining supply even below original quantity',async()=>{
  const h=harness({quantity:3,prefix:1,redeemed:9997}),before=h.read(),r=await h.run();
  assert.equal(r.status,'preflight-passed',JSON.stringify(r));assert.equal(r.itemIndex,1);assert.equal(r.itemsRemaining,2);
  assert.equal(r.budget.completedQuantity,1);assert.equal(r.budget.remainingQuantity,2);assert.equal(r.budget.projectedRemainingTotalLamports,'407019998');
  assert.equal(r.budget.nextItemKnownMinimumLamports,'203509999');assert.equal(r.budget.fullOrderTotalLamports,null);
  assert.equal(r.candidate.asset,before.items[1].asset);assert.equal(h.calls.filter(c=>c.method==='getTransaction').length,1);
  assert.equal(h.calls.filter(c=>c.method==='getSignatureStatuses').length,2);assert.deepEqual(h.read(),before);
  const sim=h.calls.filter(c=>c.method==='simulateTransaction');assert.equal(sim.length,1);
  assert.deepEqual(sim[0].params[1].accounts.addresses,[before.items[1].asset]);assert.equal(r.transactionsSent+r.signaturesCreated+r.journalWrites,0);
});

test('last item of a 50-item order revalidates all 49 exact historical transactions and needs one remaining asset',async()=>{
  const h=harness({quantity:50,prefix:49,redeemed:9998}),r=await h.run();
  assert.equal(r.status,'preflight-passed',JSON.stringify(r));assert.equal(r.itemIndex,49);assert.equal(r.budget.remainingQuantity,1);
  assert.equal(h.calls.filter(c=>c.method==='getTransaction').length,49);
  for(const call of h.calls.filter(c=>c.method==='getSignatureStatuses'))assert.equal(call.params[0].length,49);
});

test('current-only prepared and signed checks retain item 2 and exact message binding',async()=>{
  for(const signed of [false,true]){const h=harness({prepared:true,signed}),r=await h.run();
    assert.equal(r.status,signed?'submission-check-passed':'wallet-check-passed',JSON.stringify(r));assert.equal(r.itemIndex,1);
    assert.equal(r.candidate.transactionBase64,signed?h.input.response.transactionBase64:h.input.request.transactionBase64);
    assert.equal(r.readyToSign,!signed);assert.equal(r.readyToSubmit,false);assert.equal(r.salesOpen,false);}
});

test('changed or missing historical Core account blocks before cost or simulation',async()=>{
  const changes=[r=>{r.value[6]=null;},r=>{r.value[6].owner=f.policy.owner;},r=>{r.value[6].executable=true;},
    r=>{const o={buyer:f.key('stranger').publicKey.toBase58(),collection:f.plan.roles.collection};r.value[6]=account(o,0);},
    r=>{r.value[6]=account({buyer:f.policy.owner,collection:f.key('other-collection').publicKey.toBase58()},0);},
    r=>{r.value[6]=account({buyer:f.policy.owner,collection:f.plan.roles.collection},1);}];
  for(const change of changes){const h=harness({transform:(c,r)=>{if(c.method==='getMultipleAccounts')change(r);return r;}}),r=await h.run();
    assert.equal(r.code,'PRIOR_ASSET_CHANGED',JSON.stringify(r));assert.equal(h.calls.some(c=>c.method==='simulateTransaction'),false);}
});

test('claimed verified flag cannot substitute for finalized successful exact transaction',async()=>{
  const changes=[['getSignatureStatuses',r=>{r.value[0]=null;}],['getSignatureStatuses',r=>{r.value[0].confirmationStatus='confirmed';}],
    ['getSignatureStatuses',r=>{r.value[0].err={InstructionError:[0,{Custom:1}]};}],['getSignatureStatuses',r=>{r.value[0].slot++;}],
    ['getTransaction',()=>null],['getTransaction',r=>{r.transaction[0]='AAAA';}],['getTransaction',r=>{r.slot++;}],
    ['getTransaction',r=>{const tx=VersionedTransaction.deserialize(Buffer.from(r.transaction[0],'base64'));tx.signatures[0][0]^=1;r.transaction[0]=Buffer.from(tx.serialize()).toString('base64');}]];
  for(const [method,change] of changes){const h=harness({transform:(c,r)=>(()=>{if(c.method!==method)return r;const changed=change(r);return changed===undefined?r:changed;})()}),r=await h.run();
    assert.equal(r.code,'PRIOR_RECEIPT_UNVERIFIED',method+JSON.stringify(r));assert.equal(h.calls.some(c=>c.method==='simulateTransaction'),false);}
});

test('prefix account/status freshness is rechecked after simulation and stale/unavailable later-item state blocks',async()=>{
  for(const mode of ['changed','status','old-context','supply','later-asset']){
    const h=harness({redeemed:mode==='supply'?9998:9997,transform:(c,r,n)=>{
      if(mode==='changed'&&c.method==='getMultipleAccounts'&&n===2)r.value[6]=null;
      if(mode==='status'&&c.method==='getSignatureStatuses'&&n===2)r.value[0]=null;
      if(mode==='old-context'&&c.method==='getMultipleAccounts')r.context.slot=600;
      if(mode==='later-asset'&&c.method==='getMultipleAccounts')r.value[8]=r.value[6];return r;}}),r=await h.run();
    assert.equal(r.status,'blocked',mode);assert.equal(r.readyToSign,false);assert.equal(r.candidate,undefined);
  }
});

test('unknown prefix, later-item attempts, pause and already complete orders never reach RPC',async()=>{
  for(const mode of ['unknown','later','paused','complete','first-resumed']){
    const h=harness({quantity:3,prefix:mode==='complete'?3:mode==='first-resumed'?0:1});let order=h.read();
    if(mode==='unknown'){order.items[0].attempts[0].state='unknown';order.items[0].attempts[0].proof=null;}
    if(mode==='later'){order.items[2].attempts=[{...order.items[0].attempts[0],state:'wallet-pending',signature:null,proof:null}];}
    if(mode==='paused')order=f.model.transitionOrder(order,{type:'pause',revision:order.revision});
    if(mode==='first-resumed'){order=f.model.transitionOrder(order,{type:'pause',revision:order.revision});order=f.model.transitionOrder(order,{type:'resume',revision:order.revision});}
    h.set(order);
    const r=await h.run();assert.equal(r.status,'blocked',mode);assert.equal(h.calls.length,0,mode);
  }
});

test('gateway prepares item 2 only after full prefix checks and saves a distinct durable anchor',async()=>{
  const h=harness(),r=await h.dispatch(),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));
  assert.equal(body.report.candidate.itemIndex,1);assert.ok(h.values.has(anchorKey(h.readyOrder,1,1)));
  assert.notEqual(anchorKey(h.readyOrder,1,0),anchorKey(h.readyOrder,1,1));
  assert.equal(h.calls.filter(c=>c.method==='getTransaction').length,1);const before=h.calls.length;
  const restored=await h.dispatch();assert.equal(restored.status,200);assert.equal((await restored.json()).report.restored,true);assert.equal(h.calls.length,before);
});

test('gateway rejects changed prior Core asset and forged prior receipt before saving a new item anchor',async()=>{
  for(const mode of ['account','receipt']){const h=harness({transform:(c,r)=>{if(mode==='account'&&c.method==='getMultipleAccounts')r.value[6]=null;
    if(mode==='receipt'&&c.method==='getTransaction')return null;return r;}}),r=await h.dispatch();
    assert.equal(r.status,409,JSON.stringify(await r.json()));assert.equal(h.values.has(anchorKey(h.readyOrder,1,1)),false);
    assert.equal(h.calls.some(c=>c.method==='getLatestBlockhash'),false);}
});
