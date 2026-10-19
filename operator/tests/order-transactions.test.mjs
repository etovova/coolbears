// Real Core SDK instruction/serialization tests with public address fixtures.
// No private keys are generated; no signing, RPC, simulation or wallet is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { MPL_CORE_CANDY_GUARD_PROGRAM_ID, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { getMintV1InstructionDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/mintV1.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { policy } from '../prepare.mjs';
import { createOrder, transitionOrder } from '../orders/journal.mjs';
import { buildOrderTransactions } from '../orders/transactions.mjs';

// These are arbitrary public-address fixtures, not keypairs or deployment IDs.
const address = name => new PublicKey(createHash('sha256').update(`coolbears-offline-fixture:${name}`).digest()).toBase58();
const buyer = address('buyer');
const block = { blockhash: address('blockhash'), lastValidBlockHeight: 100000 };
function makeOrder(quantity = 1, changes = {}) {
  return createOrder({
    id: 'offline-sdk-test-order', cluster: 'devnet', buyer,
    machine: address('machine'), collection: address('collection'), guard: address('guard'),
    quantity, available: 9999,
    assets: Array.from({ length: quantity }, (_, index) => address(`asset-${index}`)),
    ...changes,
  });
}
function decode(template) {
  const transaction = VersionedTransaction.deserialize(template.unsignedBytes);
  const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
  return { transaction, keys, instructions: transaction.message.compiledInstructions };
}
function prepared(order) {
  const template = buildOrderTransactions(order, block).templates[0];
  return transitionOrder(order, { type: 'prepare', revision: order.revision, index: template.itemIndex,
    ...block, messageSha256: template.messageSha256 });
}

for (const quantity of [1, 50]) {
  test(`${quantity} items produce ${quantity} independent unsigned v0 transactions within 1232 bytes`, () => {
    const order = makeOrder(quantity); const original = JSON.stringify(order);
    const result = buildOrderTransactions(order, block);
    assert.equal(result.plannedTransactions, quantity); assert.equal(result.templates.length, quantity);
    assert.equal(result.quantity, quantity); assert.equal(result.unitPriceLamports, '200000000');
    assert.equal(result.totalPriceLamports, (200000000n * BigInt(quantity)).toString());
    assert.equal(result.mode, 'offline-unsigned-order'); assert.equal(result.orderId, order.id); assert.equal(result.orderRevision, order.revision);
    assert.deepEqual({ rpc: result.networkRequests, signed: result.signaturesCreated, sent: result.transactionsSent }, { rpc: 0, signed: 0, sent: 0 });
    assert.equal(result.guardPriceVerified, false); assert.equal(result.networkVerified, false); assert.equal(result.blockhashVerified, false); assert.equal(result.feeQuote, null);
    for (const [index, template] of result.templates.entries()) {
      const { transaction, keys, instructions } = decode(template);
      assert.equal(template.itemIndex, index); assert.equal(template.asset, order.items[index].asset);
      assert.equal(transaction.version, 0); assert.equal(template.version, 0);
      assert.equal(template.serializedSize, template.unsignedBytes.length); assert.ok(template.serializedSize <= 1232);
      assert.equal(transaction.signatures.length, 2); assert.ok(transaction.signatures.every(signature => signature.every(byte => byte === 0)));
      assert.deepEqual(template.requiredSigners, [buyer, order.items[index].asset]);
      assert.deepEqual(keys.slice(0, transaction.message.header.numRequiredSignatures), template.requiredSigners);
      assert.equal(transaction.message.recentBlockhash, block.blockhash); assert.equal(template.lastValidBlockHeight, block.lastValidBlockHeight);
      assert.equal(instructions.length, 2); assert.deepEqual(transaction.message.addressTableLookups, []);
      assert.equal(template.messageSha256, createHash('sha256').update(transaction.message.serialize()).digest('hex'));
    }
    assert.equal(new Set(result.templates.map(template => template.asset)).size, quantity);
    assert.equal(new Set(result.templates.map(template => template.messageSha256)).size, quantity);
    assert.equal(JSON.stringify(order), original, 'Planning must not mutate the durable order');
  });
}

test('real Core mint pays the fixed treasury while buyer is fee payer, payer, minter and NFT owner', () => {
  const order = makeOrder(); assert.notEqual(order.buyer, order.treasury);
  const { templates: [template] } = buildOrderTransactions(order, block);
  const { transaction, keys, instructions: [compute, mint] } = decode(template);
  assert.equal(keys[compute.programIdIndex], ComputeBudgetProgram.programId.toBase58());
  assert.equal(compute.data[0], 2); assert.equal(Buffer.from(compute.data).readUInt32LE(1), 300000);
  assert.equal(keys[mint.programIdIndex], MPL_CORE_CANDY_GUARD_PROGRAM_ID);
  const accounts = [...mint.accountKeyIndexes].map(index => keys[index]);
  assert.equal(accounts[0], order.guard); assert.equal(accounts[1], MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  assert.equal(accounts[2], order.machine);
  assert.equal(accounts[4], buyer, 'Candy Guard payer');
  assert.equal(accounts[5], buyer, 'Candy Guard minter');
  assert.equal(accounts[6], buyer, 'Core NFT owner');
  assert.equal(accounts[7], order.items[0].asset); assert.equal(accounts[8], order.collection); assert.equal(accounts[9], MPL_CORE_PROGRAM_ID);
  assert.equal(accounts[13], policy.owner, 'solPayment remaining destination account');
  assert.equal(accounts.length, 14);
  assert.equal(transaction.message.isAccountWritable(mint.accountKeyIndexes[13]), true);
  assert.equal(transaction.message.isAccountSigner(mint.accountKeyIndexes[13]), false);
  assert.equal(keys[0], buyer); assert.equal(template.feePayer, buyer); assert.equal(template.owner, buyer);
  assert.deepEqual(template.payment, { destination: policy.owner, lamports: '200000000' });
  // solPayment's amount is not encoded in mint data. It must be verified from
  // Candy Guard state before any future live signature, independently of this
  // intended payment amount. The SDK appends only the destination account here.
  const data = getMintV1InstructionDataSerializer().deserialize(mint.data)[0];
  assert.equal(data.mintArgs.length, 0); assert.deepEqual(data.group, { __option: 'None' });
  assert.equal(buildOrderTransactions(order, block).guardPriceVerified, false);
});

test('changing buyer changes the signer and NFT owner without changing the treasury', () => {
  const nextBuyer = address('another-buyer'); const order = makeOrder(1, { buyer: nextBuyer });
  const { templates: [template] } = buildOrderTransactions(order, block);
  const { keys, instructions: [, mint] } = decode(template);
  assert.equal(keys[0], nextBuyer);
  assert.deepEqual([4, 5, 6].map(index => keys[mint.accountKeyIndexes[index]]), [nextBuyer, nextBuyer, nextBuyer]);
  assert.equal(keys[mint.accountKeyIndexes[13]], policy.owner);
  assert.deepEqual(template.requiredSigners, [nextBuyer, order.items[0].asset]);
});

test('supplied blockhash binds each template digest without pretending to check expiry', () => {
  const order = makeOrder(); const first = buildOrderTransactions(order, block).templates[0];
  const second = buildOrderTransactions(order, { blockhash: address('next-blockhash'), lastValidBlockHeight: block.lastValidBlockHeight + 100 }).templates[0];
  assert.notEqual(first.messageSha256, second.messageSha256);
  assert.equal(decode(second).transaction.message.recentBlockhash, address('next-blockhash'));
  assert.deepEqual(first.requiredSigners, second.requiredSigners);
});

test('mainnet-beta is only an offline label: no network or chain compatibility is asserted', () => {
  const devnet = buildOrderTransactions(makeOrder(), block);
  const mainnet = buildOrderTransactions(makeOrder(1, { cluster: 'mainnet-beta' }), block);
  assert.equal(mainnet.cluster, 'mainnet-beta'); assert.equal(mainnet.networkVerified, false);
  assert.deepEqual(mainnet.templates[0].unsignedBytes, devnet.templates[0].unsignedBytes);
});

test('planning never calls fetch and returns no signatures or fee estimate', () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = () => { requests++; throw Error('Network forbidden in offline test'); };
  try {
    const result = buildOrderTransactions(makeOrder(50), block);
    assert.equal(requests, 0); assert.equal(result.feeQuote, null); assert.equal(result.signaturesCreated, 0);
    assert.ok(result.templates.every(template => decode(template).transaction.signatures.every(signature => signature.every(byte => byte === 0))));
  } finally { globalThis.fetch = originalFetch; }
});

test('invalid journal policy, quantity and paused order are rejected before building templates', () => {
  const order = makeOrder();
  for (const changed of [
    { quantity: 0 }, { quantity: 51 }, { treasury: buyer },
    { unitPriceLamports: '1' }, { totalPriceLamports: '1' }, { paused: true },
  ]) assert.throws(() => buildOrderTransactions({ ...order, ...changed }, block));
});

test('offline planner needs explicit valid blockhash, height and boolean retry choice', () => {
  const order = makeOrder();
  assert.throws(() => buildOrderTransactions(order));
  for (const blockhash of ['', null, 0, 'not-a-blockhash', '1'.repeat(31)]) assert.throws(() => buildOrderTransactions(order, { ...block, blockhash }));
  for (const lastValidBlockHeight of [0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1, '100']) assert.throws(() => buildOrderTransactions(order, { ...block, lastValidBlockHeight }));
  for (const retry of [1, 'true', null]) assert.throws(() => buildOrderTransactions(order, { ...block, retry }));
});

test('resolved items are excluded while unresolved attempts block all replanning', () => {
  let order = prepared(makeOrder(2));
  assert.throws(() => buildOrderTransactions(order, block), /RECONCILE_FIRST/);
  assert.throws(() => buildOrderTransactions(order, { ...block, retry: true }), /RECONCILE_FIRST/);
  const signature = base58.deserialize(new Uint8Array(64).fill(13))[0];
  const attempt = order.items[0].attempts[0];
  order = transitionOrder(order, { type: 'signature', revision: order.revision, index: 0, attempt: 1, signature, messageSha256: attempt.messageSha256 });
  // This is supplied fixture evidence accepted by the journal contract, not an
  // actual chain assertion made by the instruction planner or this test.
  order = transitionOrder(order, { type: 'reconcile', revision: order.revision, index: 0, attempt: 1, proof: {
    kind: 'verified', cluster: order.cluster, machine: order.machine, collection: order.collection,
    buyer: order.buyer, asset: order.items[0].asset, blockhash: block.blockhash,
    messageSha256: attempt.messageSha256, signature, commitment: 'finalized', slot: 100, accountSlot: 100,
    account: { program: MPL_CORE_PROGRAM_ID, owner: order.buyer, collection: order.collection,
      name: policy.hiddenName.replace('{index:04d}', '0001'), uri: `${policy.website}/metadata/hidden/0001.json` },
  } });
  const original = JSON.stringify(order); const result = buildOrderTransactions(order, block);
  assert.equal(result.plannedTransactions, 1); assert.equal(result.totalPriceLamports, '200000000');
  assert.equal(result.templates[0].itemIndex, 1); assert.equal(result.templates[0].asset, order.items[1].asset);
  assert.equal(JSON.stringify(order), original);
});

test('cancelled entry keeps its asset/history and requires resume plus explicit retry planning', () => {
  let order = prepared(makeOrder(2)); const asset = order.items[0].asset;
  order = transitionOrder(order, { type: 'cancelled', revision: order.revision, index: 0, attempt: 1 });
  assert.throws(() => buildOrderTransactions(order, { ...block, retry: true }), /ORDER_PAUSED/);
  order = transitionOrder(order, { type: 'resume', revision: order.revision });
  assert.throws(() => buildOrderTransactions(order, block), /RETRY_REQUIRES_REVIEW/);
  const original = JSON.stringify(order); const result = buildOrderTransactions(order, { ...block, retry: true });
  assert.equal(result.templates.length, 2); assert.equal(result.templates[0].asset, asset);
  assert.equal(JSON.stringify(order), original); assert.equal(order.items[0].attempts.length, 1);
});
