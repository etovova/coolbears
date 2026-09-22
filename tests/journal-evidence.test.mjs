import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOperationEvidence } from '../devnet/core.mjs';

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
