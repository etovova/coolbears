import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeReadFetch, retryAfterMs, validateRpcEndpoint } from '../devnet/rpc.mjs';
import { createClient, readState } from '../devnet/core.mjs';
import { settings as S } from '../devnet/settings.mjs';

const request = (method = 'getGenesisHash', id = 1, extra = {}) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }), ...extra });
const response = (options, result = S.genesis) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result }));
const fast = { totalTimeoutMs: 500, attemptTimeoutMs: 200, baseDelayMs: 5, maxDelayMs: 20 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('endpoint configuration accepts HTTPS provider keys without exposing invalid input', () => {
  assert.equal(validateRpcEndpoint('https://rpc.example/devnet?api-key=secret'), 'https://rpc.example/devnet?api-key=secret');
  for (const endpoint of ['http://rpc.example', 'javascript:secret', 'https://user:secret@rpc.example', 'https://rpc.example/#secret', 'https://rpc.example/#', ' https://rpc.example', 'https://rpc.example\\secret']) {
    assert.throws(() => validateRpcEndpoint(endpoint), error => error.code === 'ENDPOINT' && !error.message.includes('secret'));
  }
});

test('Retry-After supports seconds, HTTP dates, past dates and very long cooldowns', () => {
  const now = Date.parse('Tue, 22 Sep 2026 00:00:00 GMT');
  assert.equal(retryAfterMs('2', now), 2000);
  assert.equal(retryAfterMs('0', now), 0);
  assert.equal(retryAfterMs('Tue, 22 Sep 2026 00:00:03 GMT', now), 3000);
  assert.equal(retryAfterMs('Mon, 21 Sep 2026 00:00:00 GMT', now), 0);
  assert.equal(retryAfterMs('9'.repeat(400), now), Number.MAX_SAFE_INTEGER);
  for (const input of [null, '', '-1', '1.5', 'garbage']) assert.equal(retryAfterMs(input, now), null);
});

test('read transport rejects writes, batches, malformed requests and endpoint substitution before fetch', async () => {
  let calls = 0;
  const read = makeReadFetch(async (_url, options) => { calls++; return response(options); }, fast);
  for (const method of ['sendTransaction', 'sendRawTransaction', 'requestAirdrop', 'validatorExit']) await assert.rejects(read(S.rpc, request(method)), /Read-only/);
  await assert.rejects(read(S.rpc, { body: '[{"method":"getBalance"}]' }), /Invalid/);
  await assert.rejects(read(S.rpc, { body: '{' }), /Invalid/);
  await assert.rejects(read(S.rpc, request('getBalance', 1, { method: 'GET' })), /Read-only/);
  await assert.rejects(read('https://other.example', request()), /Unexpected/);
  assert.equal(calls, 0);
});

test('429 retries honor Retry-After and emit sanitized progress before succeeding', async () => {
  const calls = [], events = [];
  const read = makeReadFetch(async (_url, options) => {
    calls.push(Date.now());
    return calls.length === 1 ? new Response('secret', { status: 429, headers: { 'retry-after': '1' } }) : response(options);
  }, { ...fast, totalTimeoutMs: 2000, onRetry: value => events.push(value) });
  assert.equal((await (await read(S.rpc, request())).json()).result, S.genesis);
  assert.equal(calls.length, 2);
  assert.ok(calls[1] - calls[0] >= 990);
  assert.deepEqual(events, [{ attempt: 1, maxAttempts: 3, delayMs: 1000, status: 429, code: 'HTTP' }]);
  assert.equal(JSON.stringify(events).includes('secret'), false);
});

test('persistent 429 ends after three attempts with exponential cooldown', async () => {
  let calls = 0; const events = [];
  const read = makeReadFetch(async () => { calls++; return new Response('', { status: 429 }); }, { ...fast, onRetry: event => events.push(event) });
  await assert.rejects(read(S.rpc, request()), error => error.status === 429);
  assert.equal(calls, 3); assert.deepEqual(events.map(event => event.delayMs), [5, 10]);
});

test('a long Retry-After is never shortened and also blocks a later manual check', async () => {
  let calls = 0;
  const read = makeReadFetch(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); }, fast);
  const before = Date.now();
  await assert.rejects(read(S.rpc, request()), error => error.status === 429 && error.retryAfterMs === 3600000);
  await assert.rejects(read(S.rpc, request()), error => error.status === 429);
  assert.equal(calls, 1); assert.ok(Date.now() - before < 300);
});

test('transient HTTP failures repeat only the same simulation without submission', async () => {
  const bodies = [], statuses = [503, 502, 200];
  const read = makeReadFetch(async (_url, options) => {
    bodies.push(options.body); const status = statuses.shift();
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return status === 200 ? response(options, { value: { err: null } }) : new Response('', { status });
  }, fast);
  const result = await (await read(S.rpc, request('simulateTransaction'))).json();
  assert.equal(result.result.value.err, null); assert.equal(bodies.length, 3);
  assert.ok(bodies.every(body => body === bodies[0] && JSON.parse(body).method === 'simulateTransaction'));
});

test('authorization, invalid input and missing routes are not retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const read = makeReadFetch(async () => { calls++; return new Response('secret', { status }); }, fast);
    await assert.rejects(read(S.rpc, request()), error => error.status === status && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

test('network failures are bounded, sanitized and leave no provider credential in errors', async () => {
  let calls = 0;
  const endpoint = 'https://rpc.example/private-secret?api-key=secret';
  const read = makeReadFetch(async () => { calls++; throw Error(`failed to fetch ${endpoint}`); }, { ...fast, endpoint });
  await assert.rejects(read(endpoint, request()), error => error.code === 'NETWORK' && !JSON.stringify(error).includes('secret') && !error.stack.includes('secret'));
  assert.equal(calls, 3);
});

test('deadline bounds a fetch implementation that ignores abort', async () => {
  let calls = 0;
  const read = makeReadFetch(() => { calls++; return new Promise(() => {}); }, { ...fast, totalTimeoutMs: 35, attemptTimeoutMs: 200 });
  const before = Date.now();
  await assert.rejects(read(S.rpc, request()), error => error.code === 'TIMEOUT');
  assert.ok(Date.now() - before < 250); assert.equal(calls, 1);
});

test('deadline covers a stalled response body, and attempt timeout can recover', async () => {
  let calls = 0;
  const read = makeReadFetch(async (_url, options) => {
    calls++;
    return calls === 1 ? { ok: true, text: () => new Promise(() => {}) } : response(options);
  }, { ...fast, attemptTimeoutMs: 15 });
  assert.equal((await (await read(S.rpc, request())).json()).result, S.genesis);
  assert.equal(calls, 2);
});

test('caller abort before fetch, during response and during cooldown never retries', async () => {
  for (const mode of ['before', 'fetch', 'cooldown']) {
    const controller = new AbortController(); let calls = 0;
    const read = makeReadFetch(async () => {
      calls++;
      if (mode === 'cooldown') return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      return new Promise(() => {});
    }, { ...fast, totalTimeoutMs: 2000 });
    if (mode === 'before') controller.abort();
    const pending = read(S.rpc, request('getGenesisHash', 1, { signal: controller.signal }));
    if (mode !== 'before') setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending, error => error.code === 'ABORTED');
    assert.equal(calls, mode === 'before' ? 0 : 1);
  }
});

test('an action AbortSignal applies to all direct and Umi requests', async () => {
  const controller = new AbortController(); let calls = 0;
  const client = createClient(async (_url, options) => { calls++; return response(options); }, { ...fast, signal: controller.signal });
  await client.rpc('getGenesisHash');
  controller.abort();
  await assert.rejects(client.rpc('getGenesisHash'), /отменена/);
  await assert.rejects(client.umi.rpc.getLatestBlockhash(), /отменена/);
  assert.equal(calls, 1);
});

test('persistent client captures each action signal without losing the shared 429 cooldown', async () => {
  let controller = new AbortController(), calls = 0;
  const read = makeReadFetch(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); }, {
    ...fast, getSignal: () => controller.signal,
  });
  controller.abort();
  await assert.rejects(read(S.rpc, request()), error => error.code === 'ABORTED');
  assert.equal(calls, 0);
  controller = new AbortController();
  await assert.rejects(read(S.rpc, request()), error => error.status === 429);
  controller = new AbortController();
  await assert.rejects(read(S.rpc, request()), error => error.status === 429);
  assert.equal(calls, 1);
});

test('malformed JSON, mismatched ids and JSON-RPC errors stop without retries or response leakage', async () => {
  for (const body of ['not-json-secret', JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'secret' }), JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'secret', data: { endpoint: 'secret' } } }), JSON.stringify({ jsonrpc: '2.0', id: 1 })]) {
    let calls = 0;
    const read = makeReadFetch(async () => { calls++; return new Response(body); }, fast);
    await assert.rejects(read(S.rpc, request()), error => !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

test('concurrent reads are serialized and cancelled queued requests never reach fetch', async () => {
  let active = 0, maximum = 0, calls = 0;
  const read = makeReadFetch(async (_url, options) => { calls++; active++; maximum = Math.max(active, maximum); await pause(15); active--; return response(options); }, fast);
  const controller = new AbortController();
  const first = read(S.rpc, request());
  const second = read(S.rpc, request('getGenesisHash', 2, { signal: controller.signal }));
  const third = read(S.rpc, request('getGenesisHash', 3));
  controller.abort();
  await assert.rejects(second, error => error.code === 'ABORTED');
  await Promise.all([first, third]); assert.equal(maximum, 1); assert.equal(calls, 2);
});

test('the pending queue is bounded and unblocks after completion', async () => {
  const read = makeReadFetch(async (_url, options) => { await pause(10); return response(options); }, { ...fast, maxPending: 2 });
  const pending = [read(S.rpc, request()), read(S.rpc, request())];
  await assert.rejects(read(S.rpc, request()), error => error.code === 'BUSY');
  await Promise.all(pending);
  assert.equal((await (await read(S.rpc, request())).json()).result, S.genesis);
});

test('a custom endpoint is fixed for the client and a wrong cluster stops before account reads', async () => {
  const endpoint = 'https://dedicated.example/devnet?api-key=secret'; const calls = [];
  const client = createClient(async (url, options) => {
    assert.equal(url, endpoint); calls.push(JSON.parse(options.body).method);
    return response(options, 'mainnet-genesis');
  }, { ...fast, endpoint });
  await assert.rejects(readState(client), /Devnet/);
  assert.deepEqual(calls, ['getGenesisHash']);
});

test('custom HTTPS RPC supports actual Core account decoding with the same Devnet checks', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
  const endpoint = 'https://dedicated.example/devnet?api-key=secret', calls = [];
  const client = createClient(async (url, options) => {
    assert.equal(url, endpoint);
    const method = JSON.parse(options.body).method; calls.push(method);
    assert.ok(Object.hasOwn(fixtures, method));
    return response(options, fixtures[method]);
  }, { ...fast, endpoint });
  const state = await readState(client);
  assert.equal(state.machine.itemsRedeemed, 1n);
  assert.equal(state.guard.guards.addressGate.value.address, S.owner);
  assert.deepEqual(calls, ['getGenesisHash', 'getMultipleAccounts']);
});

test('Umi and direct RPC surface sanitized provider failures', async () => {
  const endpoint = 'https://dedicated.example/devnet?api-key=secret';
  for (const kind of ['network', 'jsonrpc']) {
    const client = createClient(async (_url, options) => {
      if (kind === 'network') throw Error(`endpoint=${endpoint}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, error: { code: -32000, message: endpoint } }));
    }, { ...fast, endpoint, maxAttempts: 1 });
    for (const query of [() => client.rpc('getGenesisHash'), () => client.umi.rpc.getLatestBlockhash()]) {
      await assert.rejects(query(), error => !String(error).includes('secret') && !JSON.stringify(error).includes('secret'));
    }
  }
});

test('Umi schema failures cannot expose provider credentials from malformed successful results', async () => {
  const endpoint = 'https://dedicated.example/devnet?api-key=secret';
  const client = createClient(async (_url, options) => response(options, endpoint), { ...fast, endpoint });
  await assert.rejects(client.umi.rpc.getLatestBlockhash(), error => error.code === 'RESPONSE' && !String(error).includes('secret') && !error.stack.includes('secret'));
});
