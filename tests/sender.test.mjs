// Isolated sender protocol tests: mock HTTP only, no chain submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { sendSignedTransaction } from '../devnet/sender.mjs';
import { makeReadFetch } from '../devnet/rpc.mjs';
import { settings as S } from '../devnet/settings.mjs';

const endpoint = 'https://devnet-rpc.example/private-secret?api-key=secret-marker';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ multiple = false } = {}) {
  const payer = Keypair.generate(), asset = Keypair.generate();
  const instructions = multiple ? [new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: asset.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) })] : [];
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: S.machine, instructions }).compileToV0Message());
  transaction.sign(multiple ? [payer, asset] : [payer]);
  return { transaction, bytes: transaction.serialize(), signature: base58.deserialize(transaction.signatures[0])[0] };
}
const ok = signature => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: signature }));
function safe(error, code) {
  assert.equal(error.name, 'SenderError'); assert.equal(error.code, code);
  assert.ok(!String(error).includes('secret')); assert.ok(!JSON.stringify(error).includes('secret'));
  assert.ok(!error.stack.includes('secret')); assert.equal(error.cause, undefined);
  return true;
}

test('explicit send performs exactly one base64 POST with preflight and returns the matching signature', async () => {
  const { bytes, signature } = fixture({ multiple: true }); const calls = [];
  const result = await sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return ok(signature);
  } });
  assert.equal(result, signature); assert.equal(calls.length, 1); assert.equal(calls[0].url, endpoint);
  const options = calls[0].options, body = JSON.parse(options.body);
  assert.equal(options.method, 'POST'); assert.equal(options.headers['content-type'], 'application/json');
  assert.deepEqual(body, { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(bytes).toString('base64'), {
    encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5,
  }] });
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer');
});

test('sender snapshots bytes and never signs or rewrites the transaction', async () => {
  const { bytes, signature } = fixture(); const original = Buffer.from(bytes); let payload;
  const pending = sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async (_url, options) => { payload = JSON.parse(options.body).params[0]; await tick(); return ok(signature); } });
  bytes.fill(0);
  await pending;
  assert.deepEqual(Buffer.from(payload, 'base64'), original);
});

test('default public RPC, URL aliases and invalid HTTPS URLs fail before any request', async () => {
  const { bytes, signature } = fixture(); let calls = 0;
  const fetchImpl = async () => { calls++; return ok(signature); };
  for (const target of [S.rpc, S.rpc + '/', S.rpc + '/?api-key=secret-marker', 'https://API.DEVNET.SOLANA.COM:443', 'https://api.devnet.solana.com.', 'http://devnet-rpc.example', 'https://user:secret-marker@devnet-rpc.example', endpoint + '#fragment', 'not-a-url-secret-marker']) {
    await assert.rejects(sendSignedTransaction(target, bytes, signature, { fetchImpl }), error => safe(error, 'ENDPOINT'));
  }
  assert.equal(calls, 0);
});

test('unsigned, malformed, oversized and mismatched-signature payloads fail before fetch', async () => {
  const valid = fixture({ multiple: true }), other = fixture(); let calls = 0;
  const fetchImpl = async () => { calls++; return ok(valid.signature); };
  const unsigned = VersionedTransaction.deserialize(valid.bytes); unsigned.signatures[1] = new Uint8Array(64);
  for (const [bytes, signature] of [
    [[], valid.signature], [new Uint8Array(64), valid.signature], [new Uint8Array(1233), valid.signature],
    [new Uint8Array(200).fill(8), valid.signature], [valid.bytes, 'secret-marker'], [valid.bytes, '1'.repeat(64)],
    [valid.bytes, other.signature], [unsigned.serialize(), valid.signature], [new Uint8Array([...valid.bytes, 0]), valid.signature],
  ]) await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl }), error => safe(error, 'INPUT'));
  assert.equal(calls, 0);
});

test('invalid timeout or fetch configuration is rejected without sending', async () => {
  const { bytes, signature } = fixture(); let calls = 0;
  const fetchImpl = async () => { calls++; return ok(signature); };
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 60001]) await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl, timeoutMs }), error => safe(error, 'CONFIG'));
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: null }), error => safe(error, 'CONFIG'));
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl, signal: {} }), error => safe(error, 'CONFIG'));
  assert.equal(calls, 0);
});

test('429 and all HTTP failures never retry or surface body credentials', async () => {
  const { bytes, signature } = fixture();
  for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async () => {
      calls++; return new Response('secret-marker', { status, headers: { 'retry-after': '0' } });
    } }), error => safe(error, 'HTTP') && error.status === status);
    assert.equal(calls, 1);
  }
});

test('JSON-RPC errors expose only allowlisted numeric codes, never provider messages or data', async () => {
  const { bytes, signature } = fixture();
  for (const code of [-32002, -32003, -32005, -32603, -32602, 123456789, 'secret-marker', null]) {
    let calls = 0;
    await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: endpoint, data: { logs: ['secret-marker'], signedTransaction: Buffer.from(bytes).toString('base64') } } }));
    } }), error => safe(error, 'RPC') && (Number.isInteger(code) && code < 0 ? error.rpcCode === code : error.rpcCode === undefined));
    assert.equal(calls, 1);
  }
});

test('success requires exact JSON-RPC id, shape and expected first signature', async () => {
  const { bytes, signature } = fixture(); const other = fixture();
  for (const body of [
    'secret-marker', 'null', '[]', JSON.stringify({ id: 1, result: signature }),
    JSON.stringify({ jsonrpc: '2.0', id: '1', result: signature }), JSON.stringify({ jsonrpc: '2.0', id: 2, result: signature }),
    JSON.stringify({ jsonrpc: '2.0', id: 1 }), JSON.stringify({ jsonrpc: '2.0', id: 1, result: other.signature }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: endpoint }), JSON.stringify({ jsonrpc: '2.0', id: 1, result: signature, error: { code: -32603 } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: null }), JSON.stringify({ jsonrpc: '2.0', id: 1, error: 'secret-marker' }),
  ]) {
    let calls = 0;
    await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async () => { calls++; return new Response(body); } }), error => safe(error, 'INVALID_RESPONSE'));
    assert.equal(calls, 1);
  }
});

test('network rejection is sanitized and never automatically resubmits', async () => {
  const { bytes, signature } = fixture(); let calls = 0;
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { fetchImpl: async () => {
    calls++; throw Object.assign(new Error(`fetch failed: ${endpoint}`), { code: 'secret-marker', cause: { endpoint } });
  } }), error => safe(error, 'NETWORK'));
  assert.equal(calls, 1);
});

test('timeout bounds a fetch which ignores abort, without a second request', async () => {
  const { bytes, signature } = fixture(); let calls = 0, requestSignal;
  const before = Date.now();
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { timeoutMs: 20, fetchImpl: (_url, options) => {
    calls++; requestSignal = options.signal; return new Promise(() => {});
  } }), error => safe(error, 'TIMEOUT'));
  assert.ok(Date.now() - before < 250); assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
});

test('timeout includes response body and a late response cannot trigger a resubmission', async () => {
  const { bytes, signature } = fixture(); let calls = 0, finish;
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { timeoutMs: 15, fetchImpl: async () => {
    calls++; return { ok: true, text: () => new Promise(resolve => { finish = resolve; }) };
  } }), error => safe(error, 'TIMEOUT'));
  finish(JSON.stringify({ jsonrpc: '2.0', id: 1, result: signature }));
  await tick(); assert.equal(calls, 1);
});

test('caller abort before submission sends nothing and hides its reason', async () => {
  const { bytes, signature } = fixture(); const controller = new AbortController(); let calls = 0;
  controller.abort(Error(endpoint));
  await assert.rejects(sendSignedTransaction(endpoint, bytes, signature, { signal: controller.signal, fetchImpl: async () => { calls++; return ok(signature); } }), error => safe(error, 'ABORTED'));
  assert.equal(calls, 0);
});

test('caller abort during fetch or response body remains unknown and never retries', async () => {
  const { bytes, signature } = fixture();
  for (const mode of ['fetch', 'body']) {
    const controller = new AbortController(); let calls = 0, requestSignal;
    const pending = sendSignedTransaction(endpoint, bytes, signature, { signal: controller.signal, fetchImpl: async (_url, options) => {
      calls++; requestSignal = options.signal;
      return mode === 'fetch' ? new Promise(() => {}) : { ok: true, text: () => new Promise(() => {}) };
    } });
    await tick(); controller.abort(Error(endpoint));
    await assert.rejects(pending, error => safe(error, 'ABORTED'));
    assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
  }
});

test('read-only transport remains unable to submit signed transactions', async () => {
  let calls = 0;
  const read = makeReadFetch(async () => { calls++; return ok('unused'); }, { endpoint });
  await assert.rejects(read(endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] }) }), error => error.code === 'READ_ONLY');
  assert.equal(calls, 0);
});
