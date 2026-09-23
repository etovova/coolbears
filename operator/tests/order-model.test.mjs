import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createOrderModel } from '../orders/journal-model.mjs';
import { policy } from '../prepare.mjs';
const address = n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const input = {id:'portable',cluster:'devnet',buyer:address(1),machine:address(2),collection:address(3),guard:address(4),quantity:1,available:5,assets:[address(5)]};
test('portable journal factory keeps policy instances isolated and enforces the supplied treasury', () => {
  const first = createOrderModel({...policy}), second = createOrderModel({...policy,owner:address(6)});
  assert.equal(first.createOrder(input).treasury,policy.owner);
  assert.equal(second.createOrder(input).treasury,address(6));
  assert.throws(()=>first.validateOrder(second.createOrder(input)),/PAYMENT_MISMATCH/);
});
test('portable model preserves strict fields and restart recovery for an unresolved attempt', () => {
  const model=createOrderModel({...policy}), empty=model.createOrder(input);
  assert.throws(()=>model.validateOrder({...empty,unexpected:true}),/UNEXPECTED_FIELDS/);
  const waiting=model.transitionOrder(empty,{type:'prepare',revision:0,index:0,blockhash:address(7),lastValidBlockHeight:2000,messageSha256:'a'.repeat(64)});
  const unknown=model.transitionOrder(waiting,{type:'unknown',revision:1,index:0,attempt:1});
  const reloaded=JSON.parse(JSON.stringify(unknown));
  assert.deepEqual(model.nextAction(reloaded),{type:'reconcile',index:0,attempt:1});
  assert.throws(()=>model.itemsToPlan(reloaded,{retry:true}),/RECONCILE_FIRST/);
  assert.equal(reloaded.items[0].asset,input.assets[0]);
});
