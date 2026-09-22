// Offline backend contract tests. All upstream HTTP and Durable Object storage
// are test doubles; generated signing keys never leave this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import worker, { RpcGate } from '../rpc-proxy/worker.mjs';
import { ORIGIN, LAB, ProxyError, validateRpcRequest } from '../rpc-proxy/policy.mjs';
import { errorResponse } from '../rpc-proxy/io.mjs';
import { createClient, readState, prepareMint } from '../devnet/core.mjs';

const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const address = 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
const secret = 'proxy-fixture-secret-never-return';
const clone = value => value === undefined ? undefined : structuredClone(value);
const publicRpcFixture = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
const publicAssetFixture = JSON.parse(await readFile(new URL('./fixtures/devnet-existing-asset.json', import.meta.url), 'utf8'));

// A serialized, atomic storage double also lets a new RpcGate instance share
// the same durable data, instead of accidentally testing per-instance limits.
class DurableStorage {
  data = new Map();
  transactions = 0;
  failure = null;
  #tail = Promise.resolve();
  async get(key) { if (this.failure === 'get') throw Error(secret); return clone(this.data.get(key)); }
  async put(key, value) {
    if (this.failure === 'put') throw Error(secret);
    if (typeof key === 'object') for (const [name, item] of Object.entries(key)) this.data.set(name, clone(item));
    else this.data.set(key, clone(value));
  }
  transaction(callback) {
    const pending = this.#tail.then(async () => {
      this.transactions++;
      if (this.failure === 'transaction') throw Error(secret);
      const snapshot = new Map([...this.data].map(([key, value]) => [key, clone(value)]));
      const tx = {
        get: async key => { if (this.failure === 'get') throw Error(secret); return clone(snapshot.get(key)); },
        put: async (key, value) => {
          if (this.failure === 'put') throw Error(secret);
          if (typeof key === 'object') for (const [name, item] of Object.entries(key)) snapshot.set(name, clone(item));
          else snapshot.set(key, clone(value));
        },
      };
      const result = await callback(tx);
      if (this.failure === 'commit') throw Error(secret);
      this.data = snapshot;
      return result;
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
}

function rpc(method = 'getGenesisHash', params = [], id = 1) { return { jsonrpc: '2.0', id, method, params }; }
function request(body = rpc(), options = {}) {
  const { origin = ORIGIN, method = 'POST', path = '/rpc', headers = {}, raw = false } = options;
  return new Request('https://rpc.coolbears.test' + path, {
    method,
    headers: { ...(origin === null ? {} : { origin }), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(method === 'POST' ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
}
async function wire(payer = Keypair.generate()) {
  const lab = { ...LAB, owner: payer.publicKey.toBase58() };
  const umi = createUmi('https://api.devnet.solana.com').use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(publicKey(lab.owner))));
  const asset = generateSigner(umi);
  const prepared = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
    candyMachine: publicKey(lab.machine), candyGuard: publicKey(lab.guard), collection: publicKey(lab.collection), asset, owner: publicKey(lab.owner),
    mintArgs: { solPayment: { destination: publicKey(lab.owner) } },
  })).setBlockhash({ blockhash: address, lastValidBlockHeight: 600000000 }).buildAndSign(umi);
  const unsigned = umi.transactions.serialize(prepared);
  const transaction = VersionedTransaction.deserialize(unsigned);
  transaction.sign([payer]);
  const bytes = transaction.serialize();
  return { payer, asset, umi, lab, unsigned, bytes, signature: base58.deserialize(transaction.signatures[0])[0], body: rpc('sendTransaction', [Buffer.from(bytes).toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]) };
}
function resultFor(body) {
  if (body.method === 'getGenesisHash') return genesis;
  if (body.method === 'sendTransaction') return base58.deserialize(VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64')).signatures[0])[0];
  if (body.method === 'getBalance') return { context: { slot: 1 }, value: 1000000000 };
  if (body.method === 'simulateTransaction') return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 60000 } };
  return { context: { slot: 1 }, value: null };
}
function harness({ storage = new DurableStorage(), fetchImpl, env = {}, limits, lab } = {}) {
  const h = { storage, calls: [], clock: Date.UTC(2026, 8, 22, 12), names: [], routeCalls: 0 };
  h.env = { HELIUS_API_KEY: secret, ...env };
  h.fetch = fetchImpl || (async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: resultFor(body) }), { headers: { 'content-type': 'application/json' } });
  });
  h.newGate = () => new RpcGate({ storage }, h.env, {
    now: () => h.clock,
    fetchImpl: async (url, options) => { h.calls.push({ url: String(url), options }); return h.fetch(url, options); },
    ...(limits ? { limits } : {}),
    ...(lab ? { lab } : {}),
  });
  h.gate = h.newGate();
  h.env.RPC_GATE = {
    idFromName(name) { h.names.push(name); return 'one-shared-durable-id'; },
    get(id) { assert.equal(id, 'one-shared-durable-id'); return { fetch: async req => { h.routeCalls++; return h.gate.fetch(req); } }; },
  };
  h.run = (body, options) => worker.fetch(request(body, options), h.env);
  h.advance = (milliseconds = 130) => { h.clock += milliseconds; };
  return h;
}

// Model a durable write that has committed but whose request continuation has
// not resumed yet. Later transactions can observe that write and finish first.
function holdNextCommittedTransaction(storage) {
  const transaction = storage.transaction.bind(storage);
  const committed = Promise.withResolvers(), resume = Promise.withResolvers();
  let first = true;
  storage.transaction = async callback => {
    const hold = first; first = false;
    const result = await transaction(callback);
    if (hold) { committed.resolve(); await resume.promise; }
    return result;
  };
  return { committed: committed.promise, release: () => resume.resolve() };
}

test('proxy routes allowed-origin POSTs through one global Durable Object', async () => {
  const h = harness();
  const response = await h.run();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).result, genesis);
  assert.deepEqual(h.names, ['coolbears-devnet-v1']);
  assert.equal(h.routeCalls, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.redirect, 'manual');
});

test('CORS preflight permits only the site and avoids consuming upstream quota', async () => {
  const h = harness();
  const response = await h.run(undefined, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  assert.match(response.headers.get('access-control-allow-headers'), /content-type/i);
  assert.equal(h.calls.length, 0); assert.equal(h.routeCalls, 0);
});

test('foreign or extra-header preflights do not open the proxy', async () => {
  const h = harness();
  for (const options of [
    { origin: 'https://evil.example', headers: { 'access-control-request-method': 'POST' } },
    { headers: { 'access-control-request-method': 'DELETE' } },
    { headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' } },
  ]) assert.ok((await h.run(undefined, { method: 'OPTIONS', ...options })).status >= 400);
  assert.equal(h.routeCalls, 0); assert.equal(h.calls.length, 0);
});

test('missing, lookalike and foreign origins cannot reach the Durable Object or upstream', async () => {
  const h = harness();
  for (const origin of [null, 'null', 'http://coolbears-nfts.com', ORIGIN + '.evil.example', ORIGIN + '/', 'https://evil.example', 'https://www.coolbears-nfts.com']) {
    const response = await h.run(undefined, { origin });
    assert.ok(response.status >= 400);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    if (origin !== null) assert.notEqual(response.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal(h.routeCalls, 0); assert.equal(h.calls.length, 0);
});

test('unknown routes, GET and DELETE cannot turn the proxy into an open fetch endpoint', async () => {
  const h = harness();
  for (const options of [{ path: '/' }, { path: '/rpc/another' }, { method: 'GET' }, { method: 'DELETE' }]) {
    assert.ok((await h.run(undefined, options)).status >= 400);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.routeCalls, 0);
});

test('many simultaneous clients share admission instead of each getting a private rate limit', async () => {
  const h = harness();
  const replies = await Promise.all(Array.from({ length: 16 }, (_, id) => h.run(rpc('getGenesisHash', [], id))));
  assert.equal(replies.filter(reply => reply.status === 200).length, 1);
  assert.equal(replies.filter(reply => reply.status === 429).length, 15);
  assert.equal(h.calls.length, 1);
  for (const reply of replies.filter(reply => reply.status === 429)) {
    assert.ok(Number(reply.headers.get('retry-after')) > 0);
    assert.match(reply.headers.get('access-control-expose-headers'), /retry-after/i);
  }
  h.advance(130);
  assert.equal((await h.run()).status, 200);
  assert.equal(h.calls.length, 2);
});

test('global rate limit persists across Durable Object instance restarts', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 200);
  h.gate = h.newGate();
  assert.equal((await h.run()).status, 429);
  assert.equal(h.calls.length, 1);
  h.advance(130);
  assert.equal((await h.run()).status, 429);
  h.advance(970);
  assert.equal((await h.run()).status, 200);
});

test('delayed durable commit continuation cannot burst two actual upstream reads', async () => {
  const h = harness(), hold = holdNextCommittedTransaction(h.storage);
  const delayed = h.run(rpc('getGenesisHash', [], 1));
  await hold.committed;
  assert.equal(h.calls.length, 0);
  h.advance(200);
  assert.equal((await h.run(rpc('getGenesisHash', [], 2))).status, 200);
  hold.release();
  const refusal = await delayed;
  assert.equal(refusal.status, 429);
  assert.equal((await refusal.json()).error.data.category, 'RATE_LIMIT');
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].options.body).id, 2);
  assert.equal(h.storage.data.get('rate:v1').credits, 2, 'Conservative admission stays reserved');
  h.advance(130);
  assert.equal((await h.run()).status, 200);
  assert.equal(h.calls.length, 2);
});

test('restart pause refuses a new send before reserving credit or claiming its signature', async () => {
  const f = await wire(), h = harness({ lab: f.lab });
  assert.equal((await h.run()).status, 200);
  const saved = clone(h.storage.data);
  h.gate = h.newGate(); h.advance(130);
  assert.equal((await h.run(f.body)).status, 429);
  assert.deepEqual(h.storage.data, saved);
  assert.equal(h.storage.data.has(`send:${f.signature}`), false);
  assert.equal(h.calls.length, 1);
  h.advance(970);
  assert.equal((await h.run(f.body)).status, 200);
  assert.equal(h.calls.length, 2);
});

test('a send blocked after delayed durable admission stays unknown and is never resent', async () => {
  const first = await wire(), second = await wire(first.payer);
  const h = harness({ lab: first.lab }), hold = holdNextCommittedTransaction(h.storage);
  const delayed = h.run(first.body);
  await hold.committed;
  assert.equal(h.storage.data.get(`send:${first.signature}`).state, 'unknown');
  assert.equal(h.calls.length, 0);
  h.advance(1100);
  assert.equal((await h.run(second.body)).status, 200);
  hold.release();
  assert.equal((await delayed).status, 429);
  assert.equal(h.calls.length, 1);
  assert.equal(h.storage.data.get(`send:${first.signature}`).state, 'unknown');
  h.gate = h.newGate(); h.advance(1100);
  const duplicate = await h.run(first.body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.data.category, 'SEND_ALREADY_ATTEMPTED');
  assert.equal(h.calls.length, 1);
});

test('daily credit cap spans clients and restarts, then resets on a new UTC day', async () => {
  const h = harness({ env: { DAILY_CREDIT_CAP: '2' } });
  assert.equal((await h.run()).status, 200);
  h.advance(); assert.equal((await h.run()).status, 200);
  h.advance(); h.gate = h.newGate();
  assert.equal((await h.run()).status, 429);
  assert.equal(h.calls.length, 2);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal((await h.run()).status, 200);
  assert.equal(h.calls.length, 3);
});

test('one client exhausting its daily quota does not consume another client quota', async () => {
  const h = harness({ limits: { perIpDailyCredits: 2 } });
  const firstClient = { headers: { 'cf-connecting-ip': '192.0.2.10' } };
  const otherClient = { headers: { 'cf-connecting-ip': '192.0.2.11' } };
  assert.equal((await h.run(rpc(), firstClient)).status, 200);
  h.advance(); assert.equal((await h.run(rpc(), firstClient)).status, 200);
  h.advance(); h.gate = h.newGate();
  assert.equal((await h.run(rpc(), firstClient)).status, 429);
  h.advance(1100);
  assert.equal((await h.run(rpc(), otherClient)).status, 200);
  assert.equal(h.calls.length, 3);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal((await h.run(rpc(), firstClient)).status, 200);
});

test('invalid or over-budget daily cap configuration cannot disable enforcement', async () => {
  for (const cap of ['0', '-1', '20001', '200000', '2.5', 'Infinity', 'NaN', '']) {
    const h = harness({ env: { DAILY_CREDIT_CAP: cap } });
    assert.ok((await h.run()).status >= 500);
    assert.equal(h.calls.length, 0); assert.equal(h.storage.transactions, 0);
  }
});

for (const failure of ['transaction', 'get', 'put', 'commit']) test(`durable storage ${failure} failure closes admission before upstream I/O`, async () => {
  const h = harness(); h.storage.failure = failure;
  const response = await h.run();
  assert.ok(response.status >= 500);
  assert.ok(!(await response.text()).includes(secret));
  assert.equal(h.calls.length, 0);
});

test('missing service binding or upstream key fails closed without leaking configuration', async () => {
  const h = harness({ env: { HELIUS_API_KEY: '' } });
  const response = await h.run(); assert.ok(response.status >= 500);
  assert.equal(h.calls.length, 0);
  const missingBinding = await worker.fetch(request(), { HELIUS_API_KEY: secret });
  assert.ok(missingBinding.status >= 500);
  assert.ok(!(await missingBinding.text()).includes(secret));
});

test('unapproved RPC methods, batches and malformed JSON cannot consume quota or send', async () => {
  const h = harness();
  for (const body of [[rpc()], null, {}, rpc('requestAirdrop', [address, 1]), rpc('getProgramAccounts', [address]), rpc('sendRawTransaction', ['AA==']), rpc('getGenesisHash', { url: 'http://127.0.0.1/' })]) {
    assert.ok((await h.run(body)).status >= 400);
  }
  assert.ok((await h.run('{"jsonrpc":', { raw: true })).status >= 400);
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.transactions, 0);
});

test('oversized request is rejected with no upstream request', async () => {
  const h = harness();
  const response = await h.run(' '.repeat(8193), { raw: true });
  assert.equal(response.status, 413);
  assert.equal((await h.run(' '.repeat(8193), { raw: true, headers: { 'content-length': '1' } })).status, 413);
  assert.equal(h.calls.length, 0);
});

test('content-type and compressed-body tricks are rejected before upstream access', async () => {
  const h = harness();
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/jsonp' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await h.run(rpc(), { headers })).status, 415);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.storage.transactions, 0);
});

test('caller URLs, headers and parameters cannot choose an upstream or forward credentials', async () => {
  const h = harness();
  const response = await h.run(rpc(), { headers: { authorization: 'Bearer caller-secret', cookie: 'wallet=caller-secret', 'x-upstream-url': 'http://127.0.0.1:8787/' } });
  assert.equal(response.status, 200); assert.equal(h.calls.length, 1);
  const target = new URL(h.calls[0].url);
  assert.equal(target.protocol, 'https:');
  assert.equal(target.hostname, 'devnet.helius-rpc.com');
  const headers = new Headers(h.calls[0].options.headers);
  for (const name of ['authorization', 'cookie', 'origin', 'x-upstream-url']) assert.equal(headers.get(name), null);
  h.advance();
  assert.ok((await h.run(rpc(), { path: '/rpc?url=http://169.254.169.254/latest/meta-data/' })).status >= 400);
  assert.ok((await h.run({ ...rpc(), endpoint: 'https://evil.example' })).status >= 400);
  assert.equal(h.calls.length, 1);
});

test('RPC method and parameter limits stop expensive or nested request shapes', async () => {
  for (const body of [
    rpc('getMultipleAccounts', [Array(101).fill(address), { encoding: 'base64' }]),
    rpc('getSignaturesForAddress', [address, { limit: 10000, commitment: 'finalized' }]),
    rpc('getSignatureStatuses', [Array(1001).fill('1'.repeat(88)), { searchTransactionHistory: true }]),
    rpc('getBalance', [address, { commitment: 'confirmed', endpoint: 'https://evil.example' }]),
    rpc('getGenesisHash', [{ method: 'sendTransaction', params: ['AA=='] }]),
    rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'finalized' }]),
  ]) await assert.rejects(validateRpcRequest(body));
});

test('read-only requests cannot be upgraded to sendTransaction by an upstream or nested payload', async () => {
  const h = harness();
  for (const body of [rpc('getGenesisHash'), rpc('getBalance', [address, { commitment: 'confirmed' }])]) {
    assert.equal((await h.run(body)).status, 200); h.advance();
  }
  assert.ok(h.calls.every(call => JSON.parse(call.options.body).method !== 'sendTransaction'));
  assert.equal([...h.storage.data.keys()].filter(key => key.startsWith('send:')).length, 0);
});

test('HTTP errors and redirect responses do not leak provider messages or credentials', async () => {
  for (const status of [301, 302, 307, 400, 401, 403, 429, 500, 502, 503]) {
    const h = harness({ fetchImpl: async () => new Response(secret, { status, headers: { location: 'https://evil.example/?api-key=' + secret } }) });
    const response = await h.run();
    assert.equal(response.status, status === 429 ? 429 : 502);
    const text = await response.text();
    assert.ok(!text.includes(secret)); assert.ok(!text.includes('evil.example'));
    assert.deepEqual(JSON.parse(text).error.data, { category: 'UPSTREAM_HTTP', upstreamStatus: status });
    assert.equal(response.headers.get('retry-after'), [429, 503].includes(status) ? '1' : null);
    assert.equal(response.headers.get('location'), null);
    assert.equal(h.calls.length, 1, 'No immediate retry against a failed or redirected provider');
    assert.equal(h.storage.data.get('rate:v1').credits, 1);
    assert.equal(h.calls[0].options.redirect, 'manual');
  }
});

test('upstream HTTP status diagnostics reject invalid values and stay absent from other errors', async () => {
  for (const upstreamStatus of [undefined, null, '401', 0, 100, 200, 299, 600, 401.5, NaN, Infinity, secret, { status: 401, message: secret }]) {
    const error = new ProxyError('UPSTREAM_HTTP', 502, { upstreamStatus });
    assert.equal(Object.hasOwn(error, 'upstreamStatus'), false);
    // Serialization also rejects an invalid field attached after construction.
    error.upstreamStatus = upstreamStatus;
    const response = errorResponse(error, 1);
    assert.equal(response.status, 502);
    assert.deepEqual((await response.json()).error.data, { category: 'UPSTREAM_HTTP' });
  }
  for (const category of ['CONFIGURATION', 'RATE_LIMIT', 'UPSTREAM_RPC', 'UPSTREAM_TIMEOUT', 'INTERNAL']) {
    const error = new ProxyError(category, 503, { upstreamStatus: 401 });
    assert.equal(Object.hasOwn(error, 'upstreamStatus'), false);
    error.upstreamStatus = 401;
    assert.deepEqual((await errorResponse(error).json()).error.data, { category });
  }
  for (const upstreamStatus of [300, 599]) {
    const error = new ProxyError('UPSTREAM_HTTP', 502, { upstreamStatus });
    assert.deepEqual((await errorResponse(error).json()).error.data, { category: 'UPSTREAM_HTTP', upstreamStatus });
  }
});

test('provider Retry-After cooldown applies to all clients and survives a restart', async () => {
  const h = harness();
  h.fetch = async (_url, options) => h.calls.length === 1
    ? new Response(secret, { status: 429, headers: { 'retry-after': '5' } })
    : new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: genesis }));
  const first = await h.run();
  assert.equal(first.status, 429); assert.equal(first.headers.get('retry-after'), '5');
  h.advance(2000); h.gate = h.newGate();
  assert.equal((await h.run(rpc(), { headers: { 'cf-connecting-ip': '192.0.2.50' } })).status, 429);
  assert.equal(h.calls.length, 1);
  h.advance(3000);
  assert.equal((await h.run()).status, 200); assert.equal(h.calls.length, 2);
});

test('upstream JSON-RPC errors expose no arbitrary messages, logs, stack or signed bytes', async () => {
  for (const code of [-32002, -32603, -32005, 123456789, secret]) {
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: secret, data: { logs: [secret], stack: secret, signedTransaction: secret } } })) });
    const response = await h.run();
    const body = await response.json();
    assert.ok(body.error);
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal(h.calls.length, 1);
  }
});

test('invalid, oversized or mismatched upstream responses fail without reflecting their body', async () => {
  for (const body of [
    secret, 'null', '[]', JSON.stringify({ jsonrpc: '2.0', id: 2, result: genesis }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: genesis, error: { message: secret } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: secret.repeat(6000) }),
  ]) {
    const h = harness({ fetchImpl: async () => new Response(body) });
    const response = await h.run();
    assert.ok(response.status >= 400);
    assert.ok(!(await response.text()).includes(secret));
    assert.equal(h.calls.length, 1);
  }
});

test('a provider answering with Mainnet genesis is rejected instead of blessing the wrong chain', async () => {
  const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })) });
  const response = await h.run();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.data.category, 'UPSTREAM_RESPONSE');
  assert.equal(h.calls.length, 1);
});

test('network exceptions are sanitized and consume their reserved admission', async () => {
  const h = harness({ env: { DAILY_CREDIT_CAP: '1' }, fetchImpl: async () => { throw Error('Unable to reach https://devnet.helius-rpc.com/?api-key=' + secret); } });
  const response = await h.run();
  assert.ok(response.status >= 500);
  assert.ok(!(await response.text()).includes(secret));
  h.advance(1100);
  assert.equal((await h.run()).status, 429);
  assert.equal(h.calls.length, 1);
});

for (const mode of ['fetch', 'body']) test(`upstream timeout includes ${mode} and aborts without retrying`, { timeout: 2000 }, async () => {
  let signal;
  const h = harness({ limits: { upstreamTimeoutMs: 20 }, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return mode === 'fetch' ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} }));
  } });
  const start = Date.now();
  const response = await h.run();
  assert.ok(response.status >= 500);
  assert.ok(Date.now() - start < 1000, 'A non-cooperative fetch/body must not hang the worker');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});

test('request body timeout rejects a stalled client before admission or provider I/O', { timeout: 2000 }, async () => {
  const h = harness({ limits: { requestTimeoutMs: 20 } });
  const slow = new Request('https://rpc.coolbears.test/rpc', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), duplex: 'half' });
  const start = Date.now();
  const response = await worker.fetch(slow, h.env);
  assert.ok(response.status >= 400);
  assert.ok(Date.now() - start < 1000);
  assert.equal(h.calls.length, 0); assert.equal(h.storage.transactions, 0);
});

test('a valid signed lab mint is durably marked before its single upstream POST', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  h.fetch = async (_url, options) => {
    assert.ok(h.storage.data.has('send:' + f.signature), 'Dedupe must commit before the first network byte');
    const outgoing = JSON.parse(options.body);
    assert.equal(outgoing.method, 'sendTransaction');
    assert.equal(outgoing.params[0], f.body.params[0], 'Signed wire bytes are immutable');
    assert.equal(outgoing.params[1].skipPreflight, false);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: f.signature }));
  };
  const response = await h.run(f.body);
  assert.equal(response.status, 200); assert.equal((await response.json()).result, f.signature);
  assert.equal(h.calls.length, 1);
  h.advance(1200); h.gate = h.newGate();
  const cached = await h.run({ ...f.body, id: 99 });
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), { jsonrpc: '2.0', id: 99, result: f.signature });
  assert.equal(h.calls.length, 1, 'An instance restart cannot authorize the same signature again');
  h.advance(24 * 60 * 60 * 1000); h.gate = h.newGate();
  assert.equal((await h.run(f.body)).status, 200);
  assert.equal(h.calls.length, 1, 'Daily quota reset must not erase the deduplication marker');
});

test('simultaneous duplicate signed submissions perform at most one upstream send', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.run(f.body)));
  assert.ok(responses.some(response => response.status === 200));
  for (const response of responses) {
    assert.ok([200, 409, 429].includes(response.status));
    if (response.status === 200) assert.equal((await response.json()).result, f.signature);
  }
  assert.equal(h.calls.length, 1);
});

test('distinct sends remain at least 1100 milliseconds apart while ordinary reads can proceed', async () => {
  const first = await wire(), next = await wire(first.payer);
  const h = harness({ lab: first.lab });
  assert.equal((await h.run(first.body)).status, 200);
  h.advance(130);
  assert.equal((await h.run()).status, 200);
  h.advance(130);
  assert.equal((await h.run(next.body)).status, 429);
  assert.equal(h.storage.data.has('send:' + next.signature), false, 'Rate rejection must not consume the unused signature');
  h.advance(840);
  assert.equal((await h.run(next.body)).status, 200);
  assert.equal(h.calls.filter(call => JSON.parse(call.options.body).method === 'sendTransaction').length, 2);
});

for (const mode of ['network', 'fetch-timeout', 'body-timeout']) test(`ambiguous ${mode} after sending stays deduplicated across a restart`, { timeout: 3000 }, async () => {
  const f = await wire();
  const h = harness({ lab: f.lab, limits: { upstreamTimeoutMs: 20 }, fetchImpl: async () => {
    if (mode === 'network') throw Error(secret);
    return mode === 'fetch-timeout' ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} }));
  } });
  const first = await h.run(f.body);
  assert.ok(first.status >= 500);
  assert.ok(!(await first.text()).includes(secret));
  assert.equal(h.calls.length, 1);
  assert.ok(h.storage.data.has('send:' + f.signature));
  h.advance(1200); h.gate = h.newGate();
  assert.ok((await h.run(f.body)).status >= 400);
  assert.equal(h.calls.length, 1, 'Unknown upstream outcome is not permission to resubmit');
});

test('send admission storage failure never contacts an upstream', async () => {
  const f = await wire(); const h = harness({ lab: f.lab }); h.storage.failure = 'commit';
  assert.ok((await h.run(f.body)).status >= 500);
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.data.has('send:' + f.signature), false);
});

test('a crash saving an accepted response preserves the earlier unknown marker and cannot resend', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  h.fetch = async () => {
    h.storage.failure = 'commit';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: f.signature }));
  };
  assert.ok((await h.run(f.body)).status >= 500);
  assert.equal(h.calls.length, 1);
  assert.ok(h.storage.data.has('send:' + f.signature));
  h.storage.failure = null; h.advance(1200); h.gate = h.newGate();
  assert.equal((await h.run(f.body)).status, 409);
  assert.equal(h.calls.length, 1);
});

test('an unexpected upstream send signature is rejected and cannot authorize a resend', async () => {
  const f = await wire(), other = await wire(f.payer);
  const h = harness({ lab: f.lab, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: other.signature })) });
  assert.equal((await h.run(f.body)).status, 502);
  h.advance(1200); h.gate = h.newGate();
  assert.ok((await h.run(f.body)).status >= 400);
  assert.equal(h.calls.length, 1);
});

test('unsigned, corrupted or unrelated signed transactions cannot be submitted', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  const unrelated = new VersionedTransaction(new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: address, instructions: [] }).compileToV0Message());
  unrelated.sign([f.payer]);
  const corrupted = new Uint8Array(f.bytes); corrupted[1] ^= 1;
  for (const bytes of [f.unsigned, corrupted, unrelated.serialize(), new Uint8Array([...f.bytes, 0]), new Uint8Array(1233)]) {
    const body = structuredClone(f.body); body.params[0] = Buffer.from(bytes).toString('base64');
    assert.ok((await h.run(body)).status >= 400);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.transactions, 0);
});

test('a valid signature does not authorize a changed lab mint instruction', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  const changed = VersionedTransaction.deserialize(f.bytes);
  changed.message.compiledInstructions[0].data[1] ^= 1;
  changed.sign([f.payer]);
  changed.signatures[1] = f.umi.eddsa.sign(changed.message.serialize(), f.asset);
  assert.equal(f.umi.eddsa.verify(changed.message.serialize(), changed.signatures[1], f.asset.publicKey), true);
  const body = structuredClone(f.body); body.params[0] = Buffer.from(changed.serialize()).toString('base64');
  assert.ok((await h.run(body)).status >= 400);
  assert.equal(h.calls.length, 0); assert.equal(h.storage.transactions, 0);
});

test('test-only owner override cannot be supplied through public request or environment fields', async () => {
  const f = await wire();
  const h = harness({ env: { LAB_OWNER: f.lab.owner, OWNER: f.lab.owner, LAB: f.lab } });
  assert.ok((await h.run(f.body)).status >= 400);
  assert.ok((await h.run({ ...f.body, lab: f.lab })).status >= 400);
  assert.equal(h.calls.length, 0);
});

test('simulation uses an unsigned owner and valid asset signature without creating a send marker', async () => {
  const f = await wire(); const h = harness({ lab: f.lab });
  const body = rpc('simulateTransaction', [Buffer.from(f.unsigned).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  assert.equal((await h.run(body)).status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].options.body).method, 'simulateTransaction');
  assert.equal([...h.storage.data.keys()].some(key => key.startsWith('send:')), false);
  body.params[0] = Buffer.from(f.bytes).toString('base64');
  h.advance();
  assert.ok((await h.run(body)).status >= 400, 'A fully signed packet must not use the unsigned simulation path');
  assert.equal(h.calls.length, 1);
});

test('simulation caps persist per client and globally without blocking ordinary reads', async () => {
  const f = await wire(); const h = harness({ lab: f.lab, limits: { perIpDailySimulations: 2, dailySimulations: 3 } });
  const body = rpc('simulateTransaction', [Buffer.from(f.unsigned).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  const firstClient = { headers: { 'cf-connecting-ip': '192.0.2.20' } }, otherClient = { headers: { 'cf-connecting-ip': '192.0.2.21' } };
  assert.equal((await h.run(body, firstClient)).status, 200);
  h.advance(); assert.equal((await h.run(body, firstClient)).status, 200);
  h.advance(); h.gate = h.newGate();
  assert.equal((await h.run(body, firstClient)).status, 429);
  h.advance(1100);
  assert.equal((await h.run(body, otherClient)).status, 200);
  h.advance(); assert.equal((await h.run(body, otherClient)).status, 429);
  assert.equal((await h.run(rpc(), firstClient)).status, 200);
  h.advance(24 * 60 * 60 * 1000); h.gate = h.newGate();
  h.advance(1100);
  assert.equal((await h.run(body, firstClient)).status, 200);
  assert.equal(h.calls.filter(call => JSON.parse(call.options.body).method === 'simulateTransaction').length, 4);
});

test('successful simulation results retain failure evidence while stripping provider logs and extensions', async () => {
  const f = await wire();
  const h = harness({ lab: f.lab, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
    context: { slot: 123, providerEndpoint: secret }, value: { err: { InstructionError: [1, { Custom: secret }] }, unitsConsumed: 10, logs: [secret], providerEndpoint: secret }, providerEndpoint: secret,
  } })) });
  const body = rpc('simulateTransaction', [Buffer.from(f.unsigned).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  const response = await h.run(body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.result.value.err, 'Simulation failure must not become success during sanitization');
  assert.deepEqual(result.result.value.logs, []);
  assert.equal(result.result.context.slot, 123);
  assert.equal(result.result.value.unitsConsumed, 10);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('real public account snapshots retain the rent-exempt u64 rentEpoch sentinel', async () => {
  const h = harness();
  h.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'getMultipleAccounts' ? publicRpcFixture.getMultipleAccounts : publicAssetFixture }));
  };
  const multiple = await h.run(rpc('getMultipleAccounts', [[LAB.machine, LAB.guard, LAB.collection], { encoding: 'base64', commitment: 'finalized' }]));
  assert.equal(multiple.status, 200);
  const accounts = (await multiple.json()).result.value;
  assert.equal(accounts.length, 3);
  for (let index = 0; index < accounts.length; index++) {
    assert.equal(accounts[index].rentEpoch, publicRpcFixture.getMultipleAccounts.value[index].rentEpoch);
    assert.deepEqual(accounts[index].data, publicRpcFixture.getMultipleAccounts.value[index].data);
  }
  h.advance();
  const asset = await h.run(rpc('getAccountInfo', ['J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57', { encoding: 'base64', commitment: 'finalized' }]));
  assert.equal(asset.status, 200);
  assert.deepEqual((await asset.json()).result.value, publicAssetFixture.value);
});

test('rentEpoch compatibility does not permit unsafe account balances or context slots', async () => {
  for (const property of ['lamports', 'slot']) {
    const snapshot = structuredClone(publicRpcFixture.getMultipleAccounts);
    if (property === 'lamports') snapshot.value[0].lamports = Number.MAX_SAFE_INTEGER + 1;
    else snapshot.context.slot = Number.MAX_SAFE_INTEGER + 1;
    const h = harness({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: snapshot })) });
    const response = await h.run(rpc('getMultipleAccounts', [[LAB.machine, LAB.guard, LAB.collection], { encoding: 'base64', commitment: 'finalized' }]));
    assert.equal(response.status, 502);
  }
});

test('the unmodified client reads lab state and prepares its exact SDK mint through the proxy', async () => {
  const h = harness();
  h.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = body.method === 'getBlockHeight'
      ? publicRpcFixture.getLatestBlockhash.value.lastValidBlockHeight - 200
      : publicRpcFixture[body.method] ?? resultFor(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const client = createClient(async (_url, options) => {
    h.advance();
    return h.run(JSON.parse(options.body));
  }, { endpoint: 'https://rpc.coolbears.test/rpc', minIntervalMs: 0 });
  const state = await readState(client);
  assert.equal(state.machine.itemsRedeemed, 1n);
  const prepared = await prepareMint(client, LAB.owner);
  assert.equal(prepared.bytes.length, 622);
  const transaction = VersionedTransaction.deserialize(prepared.bytes);
  assert.ok(transaction.signatures[0].every(byte => byte === 0), 'No owner signature exists in this offline preparation');
  assert.ok(transaction.signatures[1].some(byte => byte !== 0));
  assert.equal(prepared.simulation.err, null);
  assert.equal(prepared.operation.owner, LAB.owner);
  assert.ok(h.calls.some(call => JSON.parse(call.options.body).method === 'simulateTransaction'));
  assert.ok(h.calls.every(call => JSON.parse(call.options.body).method !== 'sendTransaction'));
});
