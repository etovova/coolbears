import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Connection } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createRpcFetch, retryDelay, rpcMessage } from './phantom-rpc.mjs';
const report = { checkedAt: new Date().toISOString(), scope: 'RPC transport with mocked HTTP responses; actual Umi/Web3.js integration; no wallet signing', passed: false, checks: [] };
const request = method => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
const ok = () => new Response('{"jsonrpc":"2.0","id":1,"result":"ok"}');
function fixture(responses, options = {}) {
  let clock = 0; const calls = [], waits = [];
  const rpc = createRpcFetch({ now: () => clock, wait: async ms => { waits.push(ms); clock += ms; }, minIntervalMs: 10,
    fetchImpl: async (url, init) => { calls.push({ at: clock, method: JSON.parse(init.body).method }); return responses.shift()(); }, ...options });
  return { rpc, calls, waits };
}
async function check(name, fn) { await fn(); report.checks.push(name); }
try {
  await check('429 respects Retry-After before read retry', async () => {
    const f = fixture([() => new Response('', { status: 429, headers: { 'Retry-After': '2' } }), ok]);
    assert.equal((await f.rpc.fetch('https://api.devnet.solana.com', request('getGenesisHash'))).status, 200);
    assert.deepEqual(f.calls.map(c => c.at), [0, 2000]);
  });
  await check('date Retry-After and malformed values have safe delays', () => {
    assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:03 GMT', 1000, 5000), 2000);
    assert.equal(retryDelay('nonsense', 1000, 5000), 5000);
    assert.equal(retryDelay(null, 1000, 5000), 5000);
  });
  await check('persistent rate limit stops after three attempts', async () => {
    const f = fixture(Array.from({ length: 3 }, () => () => new Response('', { status: 429 })));
    await assert.rejects(f.rpc.fetch('https://api.devnet.solana.com', request('getBalance')), /RPC_RATE_LIMIT/);
    assert.equal(f.calls.length, 3); assert.equal(f.rpc.retryAt(), 35000);
  });
  await check('long Retry-After is retained and never shortened by another click', async () => {
    const f = fixture([() => new Response('', { status: 429, headers: { 'Retry-After': '120' } })]);
    await assert.rejects(f.rpc.fetch('https://api.devnet.solana.com', request('getBalance')), /RPC_RATE_LIMIT/);
    await assert.rejects(f.rpc.fetch('https://api.devnet.solana.com', request('getGenesisHash')), /RPC_RATE_LIMIT/);
    assert.equal(f.calls.length, 1); assert.equal(f.rpc.retryAt(), 120000);
  });
  await check('concurrent reads are queued behind the same rate limit', async () => {
    const f = fixture([() => new Response('', { status: 429, headers: { 'Retry-After': '1' } }), ok, ok]);
    await Promise.all([f.rpc.fetch('https://api.devnet.solana.com', request('getBalance')), f.rpc.fetch('https://api.devnet.solana.com', request('getLatestBlockhash'))]);
    assert.deepEqual(f.calls.map(c => [c.at, c.method]), [[0, 'getBalance'], [1000, 'getBalance'], [1010, 'getLatestBlockhash']]);
  });
  await check('submission and unknown methods never retry', async () => {
    for (const method of ['sendTransaction', 'requestAirdrop', 'unknown']) {
      const f = fixture([() => new Response('', { status: 429 })]);
      await assert.rejects(f.rpc.fetch('https://api.devnet.solana.com', request(method)), /RPC_RATE_LIMIT/);
      assert.equal(f.calls.length, 1);
    }
  });
  await check('403 does not retry or claim a rate limit', async () => {
    const f = fixture([() => new Response('', { status: 403 })]);
    await assert.rejects(f.rpc.fetch('https://api.devnet.solana.com', request('getGenesisHash')), /RPC_ACCESS_DENIED/);
    assert.equal(f.calls.length, 1);
  });
  await check('JSON-RPC 429 is handled even when HTTP succeeds', async () => {
    const f = fixture([() => new Response('{"error":{"code":429}}'), ok]);
    await f.rpc.fetch('https://api.devnet.solana.com', request('getAccountInfo'));
    assert.equal(f.calls.length, 2);
  });
  await check('timeout covers the response body', async () => {
    const rpc = createRpcFetch({ timeoutMs: 5, fetchImpl: async (url, init) => ({ text: () => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')))) }) });
    await assert.rejects(rpc.fetch('https://api.devnet.solana.com', request('getBalance')), /RPC_TIMEOUT/);
  });
  await check('diagnostics contain methods/status only, never request bodies or endpoint credentials', async () => {
    const f = fixture([ok]);
    await f.rpc.fetch('https://example.com/?api-key=secret', { ...request('simulateTransaction'), body: '{"method":"simulateTransaction","params":["signed-secret"]}' });
    const text = JSON.stringify(f.rpc.diagnostics()); assert.ok(!text.includes('secret')); assert.ok(text.includes('simulateTransaction'));
  });
  await check('messages direct an unstarted operation to an available connection check', () => {
    assert.match(rpcMessage('RPC_RATE_LIMIT', false), /Проверить связь/);
    assert.doesNotMatch(rpcMessage('RPC_RATE_LIMIT', false), /Проверить результат/);
    assert.match(rpcMessage('RPC_RATE_LIMIT', true), /Проверить результат/);
  });
  await check('actual Umi and Web3.js share the transport and preserve rate-limit errors', async () => {
    const f = fixture([() => new Response('', { status: 429, headers: { 'Retry-After': '120' } })]);
    const connection = new Connection('https://api.devnet.solana.com', { fetch: f.rpc.fetch, disableRetryOnRateLimit: true });
    const umi = createUmi(connection);
    await assert.rejects(umi.rpc.getGenesisHash(), /RPC_RATE_LIMIT/); assert.equal(f.calls.length, 1);
  });
  report.passed = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; }
await writeFile(new URL('./reports/phantom-rpc.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
