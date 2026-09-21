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
    fetchImpl: async (url, init) => {
      const sent = JSON.parse(init.body); calls.push({ at: clock, method: sent.method });
      const response = responses.shift()(); const body = await response.text();
      let data; try { data = JSON.parse(body); } catch {}
      // A JSON-RPC server echoes the client's ID, including Web3.js string IDs.
      if (data?.jsonrpc) data.id = sent.id;
      return new Response(data ? JSON.stringify(data) : body, { status: response.status, headers: response.headers });
    }, ...options });
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
  await check('observed OnFinality HTTP 429 with JSON code -32029 is recognized', async () => {
    const f = fixture([() => new Response('{"error":{"code":-32029}}', { status: 429 }), ok]);
    await f.rpc.fetch('https://example.com', request('getAccountInfo'));
    assert.deepEqual(f.calls.map(c => c.at), [0, 5000]);
  });
  for (const status of [401, 500, 502, 503]) {
    await check(`HTTP ${status} fails through actual Web3.js without retrying and leaves the queue usable`, async () => {
      const f = fixture([() => new Response('upstream rejected', { status }), ok]);
      const c = new Connection('https://example.com', { fetch: f.rpc.fetch, disableRetryOnRateLimit: true });
      await assert.rejects(c.getGenesisHash()); assert.equal(f.calls.length, 1);
      assert.equal(await c.getGenesisHash(), 'ok'); assert.equal(f.calls.length, 2);
    });
  }
  await check('HTTP 200 HTML error page is rejected by actual Umi and does not poison the queue', async () => {
    const f = fixture([() => new Response('<html>error</html>'), ok]);
    const u = createUmi(new Connection('https://example.com', { fetch: f.rpc.fetch, disableRetryOnRateLimit: true }));
    await assert.rejects(u.rpc.getGenesisHash()); assert.equal(f.calls.length, 1);
    assert.equal(await u.rpc.getGenesisHash(), 'ok');
  });
  await check('HTTP 200 authentication error remains a failure and is not retried as congestion', async () => {
    const f = fixture([() => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Unauthorized"}}')]);
    const u = createUmi(new Connection('https://example.com', { fetch: f.rpc.fetch, disableRetryOnRateLimit: true }));
    await assert.rejects(u.rpc.getGenesisHash(), /Unauthorized/); assert.equal(f.calls.length, 1); assert.equal(f.rpc.retryAt(), 0);
  });
  await check('network loss fails once and a later manual request can succeed', async () => {
    const f = fixture([() => { throw TypeError('Failed to fetch'); }, ok]);
    await assert.rejects(f.rpc.fetch('https://example.com', request('getBalance')), /RPC_UNAVAILABLE/);
    await f.rpc.fetch('https://example.com', request('getBalance')); assert.equal(f.calls.length, 2);
  });
  await check('already aborted request performs no network call', async () => {
    const f = fixture([]); const controller = new AbortController(); controller.abort();
    await assert.rejects(f.rpc.fetch('https://example.com', { ...request('getBalance'), signal: controller.signal }), /RPC_ABORTED/);
    assert.equal(f.calls.length, 0);
  });
  await check('abort during fetch releases the queue for the next request', async () => {
    let calls = 0; const controller = new AbortController();
    const rpc = createRpcFetch({ minIntervalMs: 0, fetchImpl: async (url, init) => {
      if (++calls > 1) return ok();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Error('aborted'))); controller.abort();
      });
    } });
    await assert.rejects(rpc.fetch('https://example.com', { ...request('getBalance'), signal: controller.signal }), /RPC_ABORTED/);
    assert.equal((await rpc.fetch('https://example.com', request('getBalance'))).status, 200); assert.equal(calls, 2);
  });
  await check('timeout before response headers releases the queue', async () => {
    let calls = 0; const rpc = createRpcFetch({ timeoutMs: 5, minIntervalMs: 0, fetchImpl: async (url, init) => {
      if (++calls > 1) return ok();
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted'))));
    } });
    await assert.rejects(rpc.fetch('https://example.com', request('getBalance')), /RPC_TIMEOUT/);
    assert.equal((await rpc.fetch('https://example.com', request('getBalance'))).status, 200); assert.equal(calls, 2);
  });
  await check('queue time counts against the overall request deadline', async () => {
    const f = fixture([ok], { budgetMs: 5, minIntervalMs: 10 });
    const results = await Promise.allSettled([f.rpc.fetch('https://example.com', request('getBalance')), f.rpc.fetch('https://example.com', request('getBalance'))]);
    assert.equal(results[0].status, 'fulfilled'); assert.match(results[1].reason.message, /RPC_TIMEOUT/); assert.equal(f.calls.length, 1);
  });
  await check('diagnostic history is bounded and returned entries cannot mutate it', async () => {
    const f = fixture(Array.from({ length: 20 }, () => ok));
    for (let i = 0; i < 20; i++) await f.rpc.fetch('https://example.com', request('getBalance'));
    const snapshot = f.rpc.diagnostics(); assert.equal(snapshot.length, 30); snapshot[0].type = 'changed';
    assert.notEqual(f.rpc.diagnostics()[0].type, 'changed');
  });
  report.passed = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; }
await writeFile(new URL('./reports/phantom-rpc.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
