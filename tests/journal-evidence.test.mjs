import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOperationEvidence, mayStart } from '../devnet/core.mjs';

test('late wallet signature survives older recovery snapshots and cannot enable a duplicate mint', () => {
  const saved = { asset: 'same', stage: 'submitted', signature: 'late-signature' };
  for (const stage of ['unknown', 'wallet-pending', 'cancelled', 'expired', 'failed']) {
    const merged = mergeOperationEvidence({ asset: 'same', stage, signature: null }, saved);
    assert.equal(merged.signature, 'late-signature');
    assert.ok(!['cancelled', 'expired', 'failed'].includes(merged.stage));
  }
});
test('verified evidence is monotonic; a genuinely new asset keeps its own journal', () => {
  const saved = { asset: 'same', stage: 'verified', signature: 'confirmed' };
  assert.equal(mergeOperationEvidence({ asset: 'same', stage: 'unknown' }, saved), saved);
  const next = { asset: 'new', stage: 'wallet-pending', signature: null };
  assert.equal(mergeOperationEvidence(next, saved), next);
  assert.equal(mergeOperationEvidence(next, null), next);
});

test('wallet cancellation cannot authorize a new mint while a known signature is unresolved', () => {
  assert.equal(mayStart({ stage: 'cancelled', signature: 'known-signature' }), false);
  assert.equal(mayStart({ stage: 'cancelled', signature: null }), true);
});

test('late wallet error survives a recovery snapshot that started before the reply', () => {
  const walletAttempt = { wallet: 'phantom', transport: 'standard', requestedAt: '2026-09-22T08:09:00.000Z', responseAt: '2026-09-22T08:09:03.000Z', outcome: 'error', errorCategory: 'wallet-error', errorCode: -32603 };
  const saved = { asset: 'same', stage: 'unknown', signature: null, walletAttempt };
  const merged = mergeOperationEvidence({ asset: 'same', stage: 'expired', signature: null }, saved);
  assert.equal(merged.stage, 'expired');
  assert.deepEqual(merged.walletAttempt, walletAttempt);
});
