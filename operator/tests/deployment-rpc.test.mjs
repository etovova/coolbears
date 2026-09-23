import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeploymentRpc, assertCluster, GENESIS_HASHES } from '../deployment/rpc.mjs';

const secret = 'PRIVATE_RPC_SENTINEL';
const endpoint = `https://rpc.example.com/devnet?api-key=${secret}`;
const never = () => new Promise(() => {});
const reply = (request, result = null) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
const safeFailure = code => error => {
  assert.equal(error.name, 'DeploymentRpcError'); assert.equal(error.code, code);
  assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(!String(error).includes('https://'));
  return true;
};

test('explicit read-only client uses one endpoint, sequential IDs and no automatic I/O', async () => {
  const calls = [];
  const rpc = createDeploymentRpc({ endpoint, fetchImpl: async (url, options) => {
    assert.equal(url, endpoint); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.deepEqual(options.headers, { 'content-type': 'application/json' });
    const request = JSON.parse(options.body); calls.push(request);
    return reply(request, { receivedId: request.id });
  } });
  assert.equal(rpc.requests, 0); assert.equal(calls.length, 0);
  const methods = ['getGenesisHash', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getFeeForMessage',
    'getMinimumBalanceForRentExemption', 'getSignatureStatuses', 'getTransaction', 'isBlockhashValid', 'getBlockHeight'];
  for (const [index, method] of methods.entries()) assert.deepEqual(await rpc.call(method, []), { receivedId: index + 1 });
  assert.equal(rpc.requests, methods.length); assert.equal(Object.isFrozen(rpc), true);
  assert.deepEqual(calls.map(call => call.id), methods.map((_, index) => index + 1));
  assert.ok(calls.every(call => call.jsonrpc === '2.0' && Array.isArray(call.params)));
  assert.equal(JSON.stringify(rpc).includes(secret), false);
});

test('writes, simulations, airdrops, unknown methods and batches are refused before fetch', async () => {
  const rpc = createDeploymentRpc({ endpoint, fetchImpl: () => assert.fail('No fetch expected') });
  for (const method of ['sendTransaction', 'sendRawTransaction', 'simulateTransaction', 'requestAirdrop',
    'getProgramAccounts', 'getGenesisHash ', secret, ['getGenesisHash'], { method: 'sendTransaction' }, null]) {
    await assert.rejects(rpc.call(method, []), safeFailure('METHOD'));
  }
  for (const params of [null, {}, '[]', [1n], [undefined], [NaN], [() => {}], [secret.repeat(6000)]]) {
    await assert.rejects(rpc.call('getGenesisHash', params), safeFailure('PARAMS'));
  }
  const cycle = []; cycle.push(cycle);
  await assert.rejects(rpc.call('getGenesisHash', cycle), safeFailure('PARAMS'));
  assert.equal(rpc.requests, 0);
});

test('endpoint and size/deadline configuration fail closed without reflecting input', () => {
  for (const value of [undefined, '', 'http://rpc.example.com', `https://user:${secret}@rpc.example.com`,
    `${endpoint}#fragment`, `${endpoint}#`, ` ${endpoint}`, `https://rpc.example.com\\${secret}`, 'javascript:' + secret]) {
    assert.throws(() => createDeploymentRpc({ endpoint: value }), safeFailure('ENDPOINT'));
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: 0.5 }, { timeoutMs: Infinity },
    { maxResponseBytes: 0 }, { maxResponseBytes: 16 * 1024 * 1024 + 1 }, { maxResponseBytes: NaN }, { fetchImpl: null },
    { totalTimeoutMs: 0 }, { totalTimeoutMs: 600001 }, { totalTimeoutMs: 0.5 }, { totalTimeoutMs: null }]) {
    assert.throws(() => createDeploymentRpc({ endpoint, ...options }), safeFailure('CONFIGURATION'));
  }
});

test('null and false are legitimate RPC results', async () => {
  for (const result of [null, false, 0, [], { context: { slot: 7 }, value: null }]) {
    const rpc = createDeploymentRpc({ endpoint, fetchImpl: async (_url, options) => reply(JSON.parse(options.body), result) });
    assert.deepEqual(await rpc.call('getTransaction', []), result);
    assert.equal(rpc.requests, 1);
  }
});

test('wrong ID, ambiguous envelopes, malformed JSON and invalid UTF-8 fail safely', async () => {
  const bodies = [
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: secret }),
    JSON.stringify({ jsonrpc: '2.0', id: '1', result: secret }),
    JSON.stringify({ jsonrpc: '1.0', id: 1, result: secret }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: null, error: { code: -32000, message: secret } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: null, extra: secret }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: null }),
    JSON.stringify([{ jsonrpc: '2.0', id: 1, result: null }]),
    'null', secret, new Uint8Array([0xff]),
  ];
  for (const body of bodies) {
    const rpc = createDeploymentRpc({ endpoint, fetchImpl: async () => new Response(body) });
    await assert.rejects(rpc.call('getGenesisHash'), safeFailure('RESPONSE'));
    assert.equal(rpc.requests, 1);
  }
});

test('HTTP and JSON-RPC provider errors expose no response text and are not retried', async () => {
  for (const status of [301, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const rpc = createDeploymentRpc({ endpoint, fetchImpl: async () => {
      calls++; return new Response(secret, { status, headers: { 'retry-after': '1', location: endpoint } });
    } });
    await assert.rejects(rpc.call('getGenesisHash'), error => safeFailure('HTTP')(error) && error.status === status);
    assert.equal(calls, 1); assert.equal(rpc.requests, 1);
  }
  const rpc = createDeploymentRpc({ endpoint, fetchImpl: async () => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { code: -32000, message: endpoint, data: { log: secret } },
  })) });
  await assert.rejects(rpc.call('getGenesisHash'), safeFailure('RPC'));
  assert.equal(rpc.requests, 1);
});

test('network exceptions and unexpected followed redirects are redacted', async () => {
  const network = createDeploymentRpc({ endpoint, fetchImpl: async () => { throw Error(endpoint); } });
  await assert.rejects(network.call('getGenesisHash'), safeFailure('NETWORK'));
  let cancelled = 0;
  const redirected = createDeploymentRpc({ endpoint, fetchImpl: async () => ({
    status: 200, redirected: true, body: { cancel: async () => { cancelled++; } },
  }) });
  await assert.rejects(redirected.call('getGenesisHash'), safeFailure('REDIRECT'));
  assert.equal(cancelled, 1);
});

test('actual stream bytes enforce the cap even when Content-Length is missing or false', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '1000000' }]) {
    let cancelled = 0;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(100)); },
      cancel() { cancelled++; },
    });
    const rpc = createDeploymentRpc({ endpoint, maxResponseBytes: 64, fetchImpl: async () => new Response(stream, { headers }) });
    await assert.rejects(rpc.call('getMultipleAccounts'), safeFailure('RESPONSE_SIZE'));
    assert.equal(cancelled, 1);
  }
});

test('default response capacity can read a base64 872 kB machine account', async () => {
  const result = { context: { slot: 10 }, value: [{ data: [Buffer.alloc(872000).toString('base64'), 'base64'] }] };
  const rpc = createDeploymentRpc({ endpoint, fetchImpl: async (_url, options) => reply(JSON.parse(options.body), result) });
  assert.deepEqual(await rpc.call('getMultipleAccounts', []), result);
});

for (const mode of ['fetch', 'body', 'headers-and-body']) test(`deadline bounds a hostile ${mode} without a retry`, async () => {
  let calls = 0, signal, cancelled = 0;
  const rpc = createDeploymentRpc({ endpoint, timeoutMs: 45, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal;
    if (mode === 'fetch') return never();
    if (mode === 'headers-and-body') await new Promise(resolve => setTimeout(resolve, 30));
    return { status: 200, headers: new Headers(), body: { getReader: () => ({
      read: never, cancel: () => { cancelled++; return never(); }, releaseLock() {},
    }) } };
  } });
  const start = Date.now();
  await assert.rejects(rpc.call('getMultipleAccounts', []), safeFailure('TIMEOUT'));
  assert.ok(Date.now() - start < 300, 'Headers and stream share a single deadline');
  assert.equal(calls, 1); assert.equal(rpc.requests, 1); assert.equal(signal.aborted, true);
  if (mode !== 'fetch') assert.ok(cancelled >= 1);
});

test('HTTP failure is prompt even when cancelling its untrusted body never resolves', async () => {
  const rpc = createDeploymentRpc({ endpoint, timeoutMs: 1000, fetchImpl: async () => ({
    status: 429, body: { cancel: never },
  }) });
  const start = Date.now();
  await assert.rejects(rpc.call('getGenesisHash'), safeFailure('HTTP'));
  assert.ok(Date.now() - start < 200);
});

test('an endless immediately-resolved empty stream cannot starve the deadline timer', async () => {
  let cancelled = 0;
  const rpc = createDeploymentRpc({ endpoint, timeoutMs: 25, fetchImpl: async () => ({
    status: 200, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(0) }),
      cancel: async () => { cancelled++; }, releaseLock() {},
    }) },
  }) });
  const start = Date.now();
  await assert.rejects(rpc.call('getGenesisHash'), safeFailure('TIMEOUT'));
  assert.ok(Date.now() - start < 300);
  assert.ok(cancelled >= 1);
});

test('cluster binding compares full official genesis hashes and rejects wrong or abbreviated hashes', async () => {
  for (const cluster of Object.keys(GENESIS_HASHES)) {
    const rpc = createDeploymentRpc({ endpoint, fetchImpl: async (_url, options) => reply(JSON.parse(options.body), GENESIS_HASHES[cluster]) });
    assert.equal(await assertCluster(rpc, cluster), GENESIS_HASHES[cluster]);
    assert.equal(rpc.requests, 1);
  }
  for (const result of [GENESIS_HASHES['mainnet-beta'], GENESIS_HASHES.devnet.slice(0, 32), secret, null]) {
    const rpc = createDeploymentRpc({ endpoint, fetchImpl: async (_url, options) => reply(JSON.parse(options.body), result) });
    await assert.rejects(assertCluster(rpc, 'devnet'), safeFailure('GENESIS'));
  }
  let calls = 0;
  await assert.rejects(assertCluster({ call: () => { calls++; } }, 'testnet'), safeFailure('CLUSTER'));
  assert.equal(calls, 0);
  await assert.rejects(assertCluster({ call: async () => { throw Error(endpoint); } }, 'devnet'), safeFailure('NETWORK'));
});

test('an expired total budget refuses the next call before any further fetch', async () => {
  let calls = 0;
  const rpc = createDeploymentRpc({ endpoint, timeoutMs: 1000, totalTimeoutMs: 40,
    fetchImpl: async (_url, options) => { calls++; return reply(JSON.parse(options.body)); },
  });
  assert.equal(await rpc.call('getTransaction', []), null);
  await new Promise(resolve => setTimeout(resolve, 60));
  await assert.rejects(rpc.call('getBlockHeight', []), safeFailure('TIMEOUT'));
  assert.equal(calls, 1); assert.equal(rpc.requests, 1);
});

test('a later hanging call receives only the remaining shared budget', async () => {
  let calls = 0, lastSignal;
  const rpc = createDeploymentRpc({ endpoint, timeoutMs: 1000, totalTimeoutMs: 120,
    fetchImpl: async (_url, options) => {
      calls++; lastSignal = options.signal;
      if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 70)); return reply(JSON.parse(options.body)); }
      return never();
    },
  });
  const start = performance.now();
  assert.equal(await rpc.call('getTransaction', []), null);
  const secondStart = performance.now();
  await assert.rejects(rpc.call('getBlockHeight', []), safeFailure('TIMEOUT'));
  assert.ok(performance.now() - secondStart < 100, 'The later call must not receive another full budget');
  assert.ok(performance.now() - start < 200);
  assert.equal(calls, 2); assert.equal(rpc.requests, 2); assert.equal(lastSignal.aborted, true);
});
