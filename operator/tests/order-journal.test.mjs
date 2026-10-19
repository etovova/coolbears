// All addresses, signatures and normalized evidence are local fixtures. These
// tests exercise journal rules, not cryptographic signing or on-chain proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { policy } from '../prepare.mjs';
import { createOrder, validateOrder, summarizeOrder, nextAction, itemsToPlan,
  transitionOrder, saveOrder, readOrder } from '../orders/journal.mjs';

const key = byte => base58.deserialize(new Uint8Array(32).fill(byte))[0];
const sig = byte => base58.deserialize(new Uint8Array(64).fill(byte))[0];
const core = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const digest = 'a'.repeat(64);
const clone = value => structuredClone(value);
const current = (order, index = 0) => order.items[index].attempts.at(-1);

function fresh(quantity = 3, overrides = {}) {
  return createOrder({ id: 'offline-order-fixture', cluster: 'devnet', buyer: key(1),
    machine: key(2), collection: key(3), guard: key(4), quantity, available: 9999,
    assets: Array.from({ length: quantity }, (_, index) => key(index + 20)), ...overrides });
}
function event(order, type, details = {}) {
  const index = details.index ?? 0;
  return transitionOrder(order, { revision: order.revision, type, index,
    attempt: current(order, index)?.number, ...details });
}
function prepare(order, index = 0, retry = false) {
  return event(order, 'prepare', { index, retry, blockhash: key(100 + order.revision),
    lastValidBlockHeight: 500, messageSha256: digest });
}
function sign(order, index = 0) {
  return event(order, 'signature', { index, signature: sig(30 + index * 3 + current(order, index).number), messageSha256: digest });
}
function proof(order, kind, index = 0) {
  const attempt = current(order, index);
  const common = { kind, cluster: order.cluster, machine: order.machine, collection: order.collection,
    buyer: order.buyer, asset: order.items[index].asset, blockhash: attempt.blockhash,
    messageSha256: attempt.messageSha256, commitment: 'finalized', slot: 100,
    signature: attempt.signature, accountSlot: 101 };
  if (kind === 'expired') return { ...common, blockhashValid: false, blockHeight: 501,
    signatureAbsent: true, statusSlot: 101, accountAbsent: true, addressHistoryEmpty: true };
  if (kind === 'failed') return { ...common, executionFailed: true, accountAbsent: true };
  const number = String(index + 1).padStart(4, '0');
  return { ...common, account: { program: core, owner: order.buyer, collection: order.collection,
    name: `CoolBears #${number} — Hidden Bear`, uri: `${policy.website}/metadata/hidden/${number}.json` } };
}
function reconcile(order, kind, index = 0) {
  return event(order, 'reconcile', { index, proof: proof(order, kind, index) });
}
function storage() {
  const data = new Map();
  return { data, getItem: name => data.get(name) ?? null, setItem: (name, value) => data.set(name, value) };
}

test('orders of one and fifty separate buyer, treasury, total price and unquoted fees', () => {
  for (const quantity of [1, 50]) {
    const order = fresh(quantity);
    assert.equal(order.buyer, key(1));
    assert.equal(order.treasury, policy.owner);
    assert.notEqual(order.buyer, order.treasury);
    assert.equal(order.items.length, quantity);
    assert.equal(order.totalPriceLamports, String(200000000n * BigInt(quantity)));
    assert.deepEqual(nextAction(order), { type: 'prepare', index: 0 });
    const summary = summarizeOrder(order);
    assert.equal(summary.verified, 0);
    assert.equal(summary.remaining, quantity);
    assert.equal(summary.readyToSubmit, false);
    assert.equal(summary.feesAndRentQuoted, false);
    assert.equal(itemsToPlan(order).length, quantity);
  }
});

test('rejects invalid quantities, insufficient stock and reused or missing asset addresses', () => {
  for (const quantity of [0, -1, 51, 1.5, '1', NaN, Infinity]) {
    assert.throws(() => fresh(1, { quantity }), /INVALID_QUANTITY/);
  }
  for (const available of [0, 2, -1, 10000, 3.5, '3']) {
    assert.throws(() => fresh(3, { available }), /INVALID_QUANTITY/);
  }
  assert.throws(() => fresh(2, { assets: [key(20), key(20)] }), /DUPLICATE_ASSET/);
  assert.throws(() => fresh(1, { assets: [key(1)] }), /DUPLICATE_ASSET/);
  assert.throws(() => fresh(2, { assets: [key(20)] }), /INVALID_ITEMS/);
});

test('partial success survives wallet cancellation; resume still requires explicit retry review', () => {
  let order = prepare(fresh());
  order = sign(order);
  order = event(order, 'claim-send');
  order = event(order, 'submitted');
  order = reconcile(order, 'verified');
  const receipt = clone(current(order));
  order = prepare(order, 1);
  order = event(order, 'cancelled', { index: 1 });
  assert.deepEqual(nextAction(order), { type: 'paused' });
  assert.throws(() => itemsToPlan(order), /ORDER_PAUSED/);
  assert.equal(summarizeOrder(order).verified, 1);
  assert.equal(summarizeOrder(order).listedPriceForVerifiedLamports, '200000000');
  order = event(order, 'resume');
  assert.deepEqual(nextAction(order), { type: 'retry-review', index: 1 });
  assert.throws(() => prepare(order, 1), /RETRY_REQUIRES_REVIEW/);
  assert.throws(() => itemsToPlan(order), /RETRY_REQUIRES_REVIEW/);
  assert.deepEqual(itemsToPlan(order, { retry: true }).map(item => item.index), [1, 2]);
  order = prepare(order, 1, true);
  assert.equal(order.items[1].attempts.length, 2);
  assert.equal(order.items[1].attempts[0].state, 'cancelled');
  assert.deepEqual(current(order), receipt);
});

test('persisted send claim survives crash and reload as reconciliation, never another send', () => {
  const saved = storage();
  let order = fresh(1);
  saveOrder(saved, order);
  for (const advance of [prepare, sign, value => event(value, 'claim-send')]) {
    const previousRevision = order.revision;
    order = advance(order);
    saveOrder(saved, order, previousRevision);
  }
  const loaded = readOrder(saved, order.id);
  assert.equal(current(loaded).signature, current(order).signature);
  assert.deepEqual(nextAction(loaded), { type: 'reconcile', index: 0, attempt: 1 });
  assert.throws(() => prepare(loaded), /ORDER_NOT_READY/);
  assert.throws(() => event(loaded, 'claim-send'), /SEND_NOT_ALLOWED/);
  assert.throws(() => event(loaded, 'cancelled'), /CANNOT_CANCEL_SENT_ATTEMPT/);
  const verified = reconcile(loaded, 'verified');
  saveOrder(saved, verified, loaded.revision);
  assert.deepEqual(nextAction(readOrder(saved, order.id)), { type: 'complete' });
});

test('unknown attempt blocks planning and a late wallet signature supplies evidence only', () => {
  let order = event(prepare(fresh()), 'unknown');
  assert.throws(() => itemsToPlan(order, { retry: true }), /RECONCILE_FIRST/);
  assert.throws(() => prepare(order, 1), /ORDER_NOT_READY/);
  order = sign(order);
  assert.equal(current(order).state, 'unknown');
  assert.ok(current(order).signature);
  assert.throws(() => event(order, 'claim-send'), /SEND_NOT_ALLOWED/);
  assert.deepEqual(nextAction(order), { type: 'reconcile', index: 0, attempt: 1 });
});

test('rejects stale revisions, prior-attempt callbacks, changed messages and conflicting signatures', () => {
  const initial = prepare(fresh(1));
  assert.throws(() => transitionOrder(initial, { revision: 0, type: 'unknown', index: 0, attempt: 1 }), /STALE_REVISION/);
  assert.throws(() => event(initial, 'signature', { signature: sig(50), messageSha256: 'b'.repeat(64) }), /SIGNED_MESSAGE_MISMATCH/);
  let retried = reconcile(initial, 'expired');
  retried = prepare(retried, 0, true);
  assert.throws(() => event(retried, 'signature', { attempt: 1, signature: sig(50), messageSha256: digest }), /STALE_ATTEMPT/);
  let unknown = event(sign(initial), 'unknown');
  assert.throws(() => event(unknown, 'signature', { signature: sig(50), messageSha256: digest }), /SIGNATURE_CONFLICT/);
  assert.equal(current(initial).state, 'wallet-pending', 'Rejected transitions do not mutate their input');
});

test('verified receipt is irreversible and cannot be prepared, downgraded or planned again', () => {
  const verified = reconcile(sign(prepare(fresh(1))), 'verified');
  assert.equal(summarizeOrder(verified).remaining, 0);
  assert.deepEqual(nextAction(verified), { type: 'complete' });
  assert.deepEqual(itemsToPlan(verified, { retry: true }), []);
  for (const type of ['unknown', 'cancelled', 'signature', 'claim-send', 'reconcile']) {
    assert.throws(() => event(verified, type), /ITEM_ALREADY_VERIFIED/);
  }
  assert.throws(() => prepare(verified, 0, true), /ORDER_NOT_READY/);
});

test('expiry needs finalized consistent absence evidence scoped to the exact item and attempt', () => {
  const order = event(prepare(fresh(1)), 'unknown');
  const valid = proof(order, 'expired');
  for (const [field, value] of [
    ['commitment', 'confirmed'], ['blockhashValid', true], ['blockHeight', 500],
    ['signatureAbsent', false], ['accountAbsent', false], ['addressHistoryEmpty', false],
    ['accountSlot', 99], ['statusSlot', 99], ['slot', -1],
    ['cluster', 'mainnet-beta'], ['buyer', key(9)], ['machine', key(9)],
    ['collection', key(9)], ['asset', key(9)], ['blockhash', key(9)],
    ['messageSha256', 'b'.repeat(64)],
  ]) assert.throws(() => event(order, 'reconcile', { proof: { ...valid, [field]: value } }), undefined, field);
  const expired = event(order, 'reconcile', { proof: valid });
  assert.equal(current(expired).state, 'expired');
  assert.throws(() => prepare(expired), /RETRY_REQUIRES_REVIEW/);
  const retried = prepare(expired, 0, true);
  assert.deepEqual(retried.items[0].attempts[0].proof, valid);
  assert.equal(current(retried).number, 2);
});

test('finalized execution failure permits reviewed retry only with an absent asset', () => {
  const order = event(sign(prepare(fresh(1))), 'unknown');
  const valid = proof(order, 'failed');
  for (const change of [{ executionFailed: false }, { accountAbsent: false }, { commitment: 'confirmed' }, { signature: sig(80) }]) {
    assert.throws(() => event(order, 'reconcile', { proof: { ...valid, ...change } }));
  }
  const failed = event(order, 'reconcile', { proof: valid });
  assert.deepEqual(nextAction(failed), { type: 'retry-review', index: 0 });
  assert.throws(() => prepare(failed), /RETRY_REQUIRES_REVIEW/);
  assert.equal(prepare(failed, 0, true).items[0].attempts.length, 2);
});

test('rejects wrong owner/program/collection and reserved #0000 success receipts', () => {
  const order = sign(prepare(fresh(1)));
  const valid = proof(order, 'verified');
  for (const change of [
    { owner: policy.owner }, { program: key(9) }, { collection: key(9) },
    { uri: `${policy.website}/metadata/hidden/0000.json`, name: 'CoolBears #0000 — Hidden Bear' },
    { uri: 'https://unapproved.example/metadata/hidden/0001.json' },
    { name: 'CoolBears #0002 — Hidden Bear' },
  ]) assert.throws(() => event(order, 'reconcile', { proof: { ...valid, account: { ...valid.account, ...change } } }));
  assert.equal(current(order).state, 'signed');
});

test('recovery may discover a missing wallet signature, without enabling a send', () => {
  const order = event(prepare(fresh(1)), 'unknown');
  const found = { ...proof(order, 'verified'), signature: sig(60) };
  const recovered = event(order, 'reconcile', { proof: found });
  assert.equal(current(recovered).signature, sig(60));
  assert.equal(current(recovered).state, 'verified');
  assert.deepEqual(nextAction(recovered), { type: 'complete' });
});

test('storage errors, silent dropped writes and malformed saved journals fail closed', () => {
  const order = fresh(1);
  assert.throws(() => saveOrder({ getItem() { throw Error('unavailable storage'); } }, order), /unavailable storage/);
  assert.throws(() => saveOrder({ getItem: () => null, setItem() { throw Error('quota exhausted'); } }, order), /quota exhausted/);
  assert.throws(() => saveOrder({ getItem: () => null, setItem() {} }, order), /ORDER_NOT_SAVED/);
  for (const raw of ['{broken', 'null', JSON.stringify({ ...order, quantity: 50 })]) {
    assert.throws(() => readOrder({ getItem: () => raw }, order.id));
  }
  assert.equal(readOrder({ getItem: () => null }, order.id), null);
  assert.throws(() => readOrder({ getItem: () => JSON.stringify(order) }, 'another-order'), /STORAGE_ORDER_MISMATCH/);
});

test('saved scope, receipts, signatures and attempt history cannot be overwritten', () => {
  const saved = storage();
  const initial = fresh(1);
  saveOrder(saved, initial);
  const pending = prepare(initial);
  saveOrder(saved, pending, initial.revision);
  assert.throws(() => saveOrder(saved, pending, initial.revision), /STALE_REVISION/);
  const scoped = event(pending, 'pause'); scoped.buyer = key(9);
  assert.throws(() => saveOrder(saved, scoped, pending.revision), /ORDER_SCOPE_CHANGED/);
  const changed = event(pending, 'pause'); changed.items[0].attempts[0].messageSha256 = 'b'.repeat(64);
  assert.throws(() => saveOrder(saved, changed, pending.revision), /ATTEMPT_CHANGED/);
  const signed = sign(pending); saveOrder(saved, signed, pending.revision);
  const lostSignature = event(signed, 'unknown'); current(lostSignature).signature = null;
  assert.throws(() => saveOrder(saved, lostSignature, signed.revision), /SIGNATURE_CONFLICT/);
  const verified = reconcile(signed, 'verified'); saveOrder(saved, verified, signed.revision);
  const deleted = event(verified, 'pause'); deleted.items[0].attempts = [];
  assert.throws(() => saveOrder(saved, deleted, verified.revision), /HISTORY_CHANGED/);
  const downgraded = event(verified, 'pause'); current(downgraded).state = 'unknown'; current(downgraded).proof = null;
  assert.throws(() => saveOrder(saved, downgraded, verified.revision), /HISTORY_CHANGED/);
  assert.deepEqual(readOrder(saved, initial.id), verified);
});

test('storage cannot regress an uncertain or claimed dispatch back to signed and authorize resend', () => {
  for (const state of ['sending', 'submitted', 'unknown']) {
    const saved = storage();
    let order = fresh(1); saveOrder(saved, order);
    for (const advance of [prepare, sign, value => event(value, 'claim-send')]) {
      const previous = order.revision; order = advance(order); saveOrder(saved, order, previous);
    }
    if (state !== 'sending') {
      const previous = order.revision; order = event(order, state); saveOrder(saved, order, previous);
    }
    const regression = clone(order); regression.revision++; current(regression).state = 'signed';
    assert.throws(() => saveOrder(saved, regression, order.revision), /ATTEMPT_REGRESSION/);
    assert.equal(current(readOrder(saved, order.id)).state, state);
  }
});

test('validation refuses unresolved historical attempts and simultaneous active items', () => {
  const pending = prepare(fresh(2));
  const history = clone(pending);
  history.items[0].attempts.push({ ...clone(current(pending)), number: 2 });
  assert.throws(() => validateOrder(history), /UNRESOLVED_HISTORY/);
  const parallel = clone(pending);
  parallel.items[1].attempts.push(clone(current(pending)));
  assert.throws(() => validateOrder(parallel), /MULTIPLE_ACTIVE_ATTEMPTS/);
});

test('a fresh persisted journal cannot begin with injected attempts or skip the first item', () => {
  const initial = fresh(2), prepared = prepare(initial);
  const injected = clone(prepared); injected.revision = 0;
  assert.throws(() => saveOrder(storage(), injected), /INITIAL_ORDER_NOT_EMPTY/);
  const saved = storage(); saveOrder(saved, initial);
  const skipped = clone(initial); skipped.revision++;
  skipped.items[1].attempts = [clone(current(prepared))];
  assert.throws(() => saveOrder(saved, skipped, initial.revision), /HISTORY_CHANGED/);
  assert.deepEqual(readOrder(saved, initial.id), initial);
});

test('reviewed retry preserves durable expiry proof and rejects rewriting that old proof', () => {
  const saved = storage();
  let order = fresh(1); saveOrder(saved, order);
  for (const advance of [prepare, value => event(value, 'unknown'), value => reconcile(value, 'expired'), value => prepare(value, 0, true)]) {
    const previous = order.revision; order = advance(order); saveOrder(saved, order, previous);
  }
  const reloaded = readOrder(saved, order.id);
  assert.equal(reloaded.items[0].attempts.length, 2);
  assert.equal(reloaded.items[0].attempts[0].state, 'expired');
  assert.equal(reloaded.items[0].attempts[0].proof.blockHeight, 501);
  assert.deepEqual(nextAction(reloaded), { type: 'reconcile', index: 0, attempt: 2 });
  const changed = event(reloaded, 'pause');
  changed.items[0].attempts[0].proof.blockHeight = 502;
  assert.throws(() => saveOrder(saved, changed, reloaded.revision), /HISTORY_CHANGED/);
});
