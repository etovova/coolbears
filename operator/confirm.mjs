import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { base58 } from '@metaplex-foundation/umi/serializers';

// Confirm over HTTPS, without depending on a WebSocket through the system proxy.
export async function confirmSignature(endpoint, signature, { commitment = 'finalized', timeoutMs = 60000, intervalMs = 1200, fetchImpl = fetch } = {}) {
  const encoded = typeof signature === 'string' ? signature : base58.deserialize(signature)[0];
  assert.ok(['confirmed', 'finalized'].includes(commitment), 'Confirmed or finalized commitment required');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[encoded], { searchTransactionHistory: true }] }),
      signal: AbortSignal.timeout(Math.min(15000, Math.max(1, timeoutMs - (Date.now() - started)))),
    });
    assert.ok(response.ok, `Confirmation HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.id, 1);
    assert.ok(!body.error, `Confirmation RPC error ${body.error?.code}`);
    assert.ok(Array.isArray(body.result?.value) && body.result.value.length === 1, 'Invalid signature status response');
    const status = body.result.value[0];
    if (status) {
      assert.equal(status.err, null, `TRANSACTION_FAILED: ${JSON.stringify(status.err)}`);
      const accepted = status.confirmationStatus === 'finalized' || (commitment === 'confirmed' && status.confirmationStatus === 'confirmed');
      if (accepted) return { context: { slot: status.slot }, value: { err: null }, confirmationStatus: status.confirmationStatus, signature: encoded };
    }
    await setTimeout(intervalMs);
  }
  throw Error('CONFIRMATION_UNKNOWN: inspect the stored signature; do not create a replacement transaction');
}
