import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, performOperation } from '../chain/journal.mjs';
import { assertQuantity, validateCommitment, commitmentFor, indexFromName, assertRevealTime, SPEC } from '../chain/spec.mjs';
function fixture() {
  const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v) };
  const journal = new Journal(storage, 'devnet:owner'); let exists = false, sent = 0;
  const operation = { id: 'asset:stable-address', journal, inspect: async () => exists,
    prepare: async () => ({ transaction: {}, record: { target: 'stable-address', lastValidBlockHeight: 100 } }),
    submit: async () => { sent++; exists = true; return 'signature'; }, confirm: async () => true };
  return { storage, journal, operation, sent: () => sent, setExists: x => { exists = x; } };
}
test('saved before signing; confirmed operations never resubmit', async () => {
  const f = fixture(), submit = f.operation.submit;
  f.operation.submit = async tx => { assert.equal(f.journal.get(f.operation.id).state, 'submitting'); return submit(tx); };
  await performOperation(f.operation); await performOperation(f.operation); assert.equal(f.sent(), 1);
});
test('storage failure prevents signing', async () => {
  const f = fixture(); f.storage.setItem = () => { throw Error('QuotaExceeded'); };
  await assert.rejects(performOperation(f.operation), /QuotaExceeded/); assert.equal(f.sent(), 0);
});
test('lost wallet response reconciles existing account without another signature', async () => {
  const f = fixture(), submit = f.operation.submit;
  f.operation.submit = async tx => { await submit(tx); throw Error('transport lost'); };
  await assert.rejects(performOperation(f.operation), /transport lost/);
  assert.equal(f.journal.get(f.operation.id).state, 'unknown');
  await performOperation(f.operation); assert.equal(f.sent(), 1);
});
test('unknown absent operation stays blocked', async () => {
  const f = fixture(); f.journal.put(f.operation.id, { state: 'unknown', target: 'stable-address' });
  await assert.rejects(performOperation(f.operation), /reconciliation/); assert.equal(f.sent(), 0);
});
test('signature without expected account is not successful', async () => {
  const f = fixture(); f.operation.submit = async () => 'signature';
  await assert.rejects(performOperation(f.operation), /Confirmation pending/);
  assert.equal(f.journal.get(f.operation.id).state, 'submitted');
});
test('cancellation keeps target for a later explicit attempt', async () => {
  const f = fixture(), submit = f.operation.submit;
  f.operation.submit = async () => { throw Object.assign(Error('cancelled'), { code: 4001 }); };
  await assert.rejects(performOperation(f.operation)); assert.equal(f.journal.get(f.operation.id).state, 'cancelled');
  assert.equal(f.journal.get(f.operation.id).target, 'stable-address');
  f.operation.submit = submit; await performOperation(f.operation); assert.equal(f.sent(), 1);
});
test('imported account without journal is recovered from chain', async () => {
  const f = fixture(); f.setExists(true); await performOperation(f.operation); assert.equal(f.sent(), 0);
});
test('lost confirmation preserves signature and completed work', async () => {
  const f = fixture(); f.operation.confirm = async () => { throw Error('offline'); };
  await assert.rejects(performOperation(f.operation), /offline/);
  assert.equal(f.journal.get(f.operation.id).signature, 'signature');
  await performOperation(f.operation); assert.equal(f.sent(), 1);
});
test('confirmed receipt is checked again', async () => {
  const f = fixture(); f.journal.put(f.operation.id, { state: 'confirmed' });
  await assert.rejects(performOperation(f.operation), /does not match/); assert.equal(f.sent(), 0);
});
test('wallet and network journals are isolated', () => {
  const f = fixture(); f.journal.put('a', { state: 'confirmed' });
  assert.equal(new Journal(f.storage, 'mainnet:owner').get('a'), undefined);
  assert.equal(new Journal(f.storage, 'devnet:buyer').get('a'), undefined);
});
test('quantity, date, hash and names reject malformed inputs', () => {
  for (const n of [0,-1,51,1.1,NaN,Infinity,'1',null]) assert.throws(() => assertQuantity(n));
  assert.equal(assertQuantity(50), 50);
  for (const n of [-1,null,NaN,SPEC.revealNotBefore-1]) assert.throws(() => assertRevealTime(n));
  assertRevealTime(SPEC.revealNotBefore);
  for (const name of ['CoolBears #10000','CoolBears #1x','Other #1','CoolBears #-1']) assert.throws(() => indexFromName(name));
  assert.equal(indexFromName('CoolBears #0000 — Hidden Bear'), 0);
  for (const hash of ['', '00'.repeat(32), 'ab'.repeat(31), 'GG'.repeat(32)]) assert.throws(() => validateCommitment(hash));
});
test('commitment binds all 10000 ordered names and URIs', async () => {
  const map = Array.from({ length: 10000 }, (_, index) => ({ index, name: `CoolBears #${String(index).padStart(4,'0')}`, uri: `https://example.com/${index}.json` }));
  const hash = await commitmentFor(map); map[9999].uri = 'https://example.com/changed.json';
  assert.notEqual(await commitmentFor(map), hash); map[2].index = 3;
  await assert.rejects(commitmentFor(map), /ordering/);
});
