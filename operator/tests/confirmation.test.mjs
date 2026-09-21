import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmSignature } from '../confirm.mjs';

const endpoint = 'https://rpc.invalid';
const response = (status) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [status] } }));
test('a positive slot with a transaction error is never treated as success', async () => {
  await assert.rejects(confirmSignature(endpoint, 'test', { fetchImpl: async () => response({ slot: 123, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' }) }), /TRANSACTION_FAILED/);
});
test('finalized confirmation waits through null and confirmed statuses without resubmission', async () => {
  let calls = 0;
  const result = await confirmSignature(endpoint, 'test', { intervalMs: 0, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.method, 'getSignatureStatuses');
    assert.equal(body.params[1].searchTransactionHistory, true);
    calls++;
    return response(calls === 1 ? null : { slot: 123, err: null, confirmationStatus: calls === 2 ? 'confirmed' : 'finalized' });
  } });
  assert.equal(calls, 3);
  assert.equal(result.confirmationStatus, 'finalized');
});
test('confirmation refuses rate limits without retrying or masking unknown outcome', async () => {
  let calls = 0;
  await assert.rejects(confirmSignature(endpoint, 'test', { fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } }), /HTTP 429/);
  assert.equal(calls, 1);
});
test('a missing signature at the deadline is unknown, not failed or successful', async () => {
  await assert.rejects(confirmSignature(endpoint, 'test', { timeoutMs: 5, intervalMs: 0, fetchImpl: async () => response(null) }), /CONFIRMATION_UNKNOWN/);
});
test('malformed confirmation and processed-only requests are rejected', async () => {
  await assert.rejects(confirmSignature(endpoint, 'test', { fetchImpl: async () => new Response('{}') }));
  await assert.rejects(confirmSignature(endpoint, 'test', { commitment: 'processed' }));
});
