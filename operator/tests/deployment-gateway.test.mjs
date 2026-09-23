import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy as approved } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { createScopedDeploymentRpc } from '../deployment/scoped-rpc.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { makeGateway } from '../deployment/gateway/worker.mjs';
import { createGatewayFetch } from '../deployment/gateway/client.mjs';
import { inspectSignedDeploymentTransaction } from '../deployment/signing.mjs';
const endpoint = 'https://operator.test/rpc', token = 'T'.repeat(43), secret = 'PRIVATE_SENTINEL';
const key = n => Keypair.fromSeed(createHash('sha256').update(`operator-gateway:${n}`).digest());
const owner = key('owner'), collection = key('collection');
let manifest, compiled, plan, originalOwner, originalFetch;
before(async () => {
  originalOwner = approved.owner; approved.owner = owner.publicKey.toBase58();
  originalFetch = globalThis.fetch; globalThis.fetch = () => assert.fail('Live network forbidden');
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
    reservedAsset: key('asset').publicKey.toBase58(), machine: key('machine').publicKey.toBase58(),
    blockhash: key('hash').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
  manifest = deploymentManifestFromPlan('gateway-fixture', plan);
  compiled = await compileDeploymentRpcPolicy(manifest, { allowSimulation: true });
});
after(() => { approved.owner = originalOwner; globalThis.fetch = originalFetch; });
function memory() {
  const values = new Map();
  return { values, async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); }, async transaction(fn) { return fn(this); } };
}
function harness({ storage = memory(), vars = {}, responder, candidate = compiled, allowSubmission = false } = {}) {
  let now = 1800000000000;
  const env = { OPERATOR_RPC_TOKEN: token, HELIUS_API_KEY: secret, ...vars }, calls = [];
  const { DeploymentGate, worker } = makeGateway(candidate, { allowSubmission });
  const options = { clock: () => now, pause: async ms => { now += ms; }, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).hostname, 'devnet.helius-rpc.com');
    assert.equal(new URL(url).searchParams.get('api-key'), secret);
    assert.equal(new Headers(init.headers).has('authorization'), false); assert.equal(init.redirect, 'manual');
    const rpc = JSON.parse(init.body); calls.push({ ...rpc, at: now });
    const response = responder && await responder(rpc, init);
    return response ?? new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
      result: rpc.method === 'getGenesisHash' ? GENESIS_HASHES.devnet : null }));
  } };
  let gate = new DeploymentGate({ storage }, env, options);
  env.DEPLOYMENT_GATE = { idFromName: name => name, get: () => gate };
  return { calls, storage, env, advance: ms => { now += ms; }, restart: () => { gate = new DeploymentGate({ storage }, env, options); },
    async fetch(url, init) { return worker.fetch(new Request(url, init), env); },
    async call(method = 'getGenesisHash', params = [], extra = {}) {
      return worker.fetch(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) }), env);
    } };
}
const category = async response => (await response.json()).error.data.category;

test('auth, browser headers, HTTP path, batch and write requests fail before upstream or credits', async () => {
  const h = harness();
  for (const [extra, status] of [[{ headers: { authorization: '' } }, 401], [{ headers: { authorization: `Bearer ${token}x` } }, 401],
    [{ headers: { origin: 'https://coolbears-nfts.com' } }, 403], [{ headers: { cookie: 'x=1' } }, 403],
    [{ headers: { 'content-encoding': 'gzip' } }, 415], [{ body: '[{"jsonrpc":"2.0"}]' }, 400], [{ body: '{}', method: 'PUT' }, 405]]) {
    const response = await h.call('getGenesisHash', [], extra); assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok(!(await response.text()).includes(secret));
  }
  for (const method of ['sendTransaction', 'requestAirdrop', 'getProgramAccounts']) assert.equal((await h.call(method)).status, 400);
  assert.equal((await h.call('getBalance', [key('stranger').publicKey.toBase58(), { commitment: 'finalized' }])).status, 400);
  assert.equal((await h.fetch(endpoint + '?x=1', { method: 'POST' })).status, 404);
  assert.equal(h.calls.length, 0); assert.equal(h.storage.values.size, 0);
});

test('shared client/server policy accepts all 1431 messages with fresh hashes and the full machine response', async () => {
  const h = harness({ responder: rpc => rpc.method === 'getMultipleAccounts' ? new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
    result: { context: { slot: 9 }, value: [null, null, null, null, null, { data: [Buffer.alloc(plan.machineSpace).toString('base64'), 'base64'] }, null] } })) : undefined });
  const fetchImpl = createGatewayFetch({ endpoint, token, fetchImpl: h.fetch });
  const client = await createScopedDeploymentRpc({ manifest, endpoint, fetchImpl });
  for (const step of plan.steps) {
    const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
    tx.message.recentBlockhash = key('fresh').publicKey.toBase58();
    assert.equal(await client.call('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'confirmed' }]), null);
  }
  const result = await client.call('getMultipleAccounts', [compiled.accounts, { encoding: 'base64', commitment: 'finalized' }]);
  assert.equal(Buffer.from(result.value[5].data[0], 'base64').length, 871827);
  assert.equal(h.calls.length, 1433);
  assert.ok(h.calls.slice(1).every((call, i) => call.at - h.calls[i].at >= 200));
  assert.equal([...h.storage.values.values()][0].used, 1433);
});

test('server checks genesis itself; a mismatched cluster blocks every account query', async () => {
  const h = harness({ responder: rpc => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: GENESIS_HASHES['mainnet-beta'] })) });
  const response = await h.call('getBalance', [compiled.owner, { commitment: 'finalized' }]);
  assert.equal(response.status, 502); assert.equal(await category(response), 'GENESIS');
  assert.deepEqual(h.calls.map(call => call.method), ['getGenesisHash']);
});

test('durable daily quota survives recreation, clock rollback and token rotation', async () => {
  const h = harness({ vars: { DAILY_CREDIT_CAP: '2' } });
  assert.equal((await h.call()).status, 200); h.restart();
  assert.equal((await h.call()).status, 200); h.restart(); h.env.OPERATOR_RPC_TOKEN = 'R'.repeat(43);
  h.advance(-86400000);
  let response = await h.call('getGenesisHash', [], { headers: { authorization: `Bearer ${'R'.repeat(43)}` } });
  assert.equal(response.status, 429); assert.equal(h.calls.length, 2);
  h.advance(86400000 + 1000);
  response = await h.call('getGenesisHash', [], { headers: { authorization: `Bearer ${'R'.repeat(43)}` } });
  assert.equal(await category(response), 'DAILY_LIMIT'); assert.equal(h.calls.length, 2);
  h.advance(86400000);
  assert.equal((await h.call('getGenesisHash', [], { headers: { authorization: `Bearer ${'R'.repeat(43)}` } })).status, 200);
});

test('provider 429 persists cooldown and charges one failed attempt without retries', async () => {
  const h = harness({ responder: () => new Response(secret, { status: 429, headers: { 'retry-after': '3' } }) });
  const first = await h.call(); assert.equal(first.status, 429); assert.equal(first.headers.get('retry-after'), '3');
  assert.equal(await category(first), 'UPSTREAM_HTTP'); assert.equal(h.calls.length, 1);
  h.restart(); const second = await h.call(); assert.equal(second.status, 429); assert.equal(await category(second), 'COOLDOWN');
  assert.equal(h.calls.length, 1); assert.equal([...h.storage.values.values()][0].used, 1);
  h.advance(3000); await h.call(); assert.equal(h.calls.length, 2);
});

test('crash reservation and corrupt or failed storage never bypass the durable ledger', async () => {
  const h = harness(); await h.call();
  const [name, value] = [...h.storage.values.entries()][0];
  h.storage.values.set(name, { ...value, holdUntil: value.nextAt + 15000 }); h.restart();
  assert.equal((await h.call()).status, 429); assert.equal(h.calls.length, 1);
  h.storage.values.set(name, { ...value, used: -1 });
  assert.equal(await category(await h.call()), 'LEDGER'); assert.equal(h.calls.length, 1);
  const failed = harness({ storage: { async get() { return undefined; }, async transaction() { throw Error(secret); } } });
  assert.equal(await category(await failed.call()), 'UNAVAILABLE'); assert.equal(failed.calls.length, 0);
});

test('request and response size limits and provider errors remain bounded and sanitized', async () => {
  const h = harness();
  assert.equal((await h.call('getGenesisHash', [], { body: ' '.repeat(8193) })).status, 413);
  assert.equal(h.calls.length, 0);
  for (const response of [new Response('x'.repeat(4194305)), new Response('{}', { headers: { 'content-length': '4194305' } }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: secret } })), new Response(null, { status: 302, headers: { location: `https://evil.test/${secret}` } })]) {
    const rejected = harness({ responder: () => response }); const result = await rejected.call();
    assert.equal(result.status, 502); assert.ok(!(await result.text()).includes(secret)); assert.equal(rejected.calls.length, 1);
  }
});

test('simulation verifies signed bytes, server opt-in and separate daily simulation quota', async () => {
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transactionBase64, 'base64'));
  const params = () => [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: true,
    replaceRecentBlockhash: false, minContextSlot: 0 }];
  const h = harness({ vars: { DAILY_SIMULATION_CAP: '1' } });
  assert.equal((await h.call('simulateTransaction', params())).status, 400);
  tx.sign([owner, collection]); assert.equal((await h.call('simulateTransaction', params())).status, 200);
  assert.equal(await category(await h.call('simulateTransaction', params())), 'DAILY_LIMIT');
  assert.equal(h.calls.filter(call => call.method === 'simulateTransaction').length, 1);
  tx.message.compiledInstructions[0].data[0] ^= 1;
  assert.equal((await h.call('simulateTransaction', params())).status, 400);
  const disabled = harness({ candidate: { ...compiled, allowSimulation: false } });
  assert.equal((await disabled.call('simulateTransaction', params())).status, 400); assert.equal(disabled.calls.length, 0);
});

test('gateway client serializes concurrent calls, aborts queued work, pins destination and never retries HTTP errors', async () => {
  let release, active = 0, max = 0, calls = 0;
  const fetchImpl = createGatewayFetch({ endpoint, token, fetchImpl: async (_url, init) => {
    calls++; active++; max = Math.max(max, active); assert.equal(init.headers.get('authorization'), `Bearer ${token}`);
    if (calls === 1) await new Promise(resolve => { release = resolve; }); active--;
    return new Response('', { status: 429 });
  } });
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  const first = fetchImpl(endpoint, init), controller = new AbortController();
  const aborted = fetchImpl(endpoint, { ...init, signal: controller.signal });
  const handled = assert.rejects(aborted, error => error.code === 'TIMEOUT');
  await Promise.resolve(); controller.abort(); release(); await first; await handled;
  await Promise.all(Array.from({ length: 8 }, () => fetchImpl(endpoint, init)));
  assert.equal(max, 1); assert.equal(calls, 9);
  await assert.rejects(fetchImpl('https://evil.test/rpc', init), error => error.code === 'CONFIGURATION');
  assert.equal(calls, 9);
  for (const invalid of ['https://operator.test/rpc?key=x', 'http://operator.test/rpc', 'https://operator.test/rpc#'])
    assert.throws(() => createGatewayFetch({ endpoint: invalid, token }));
});

function signedSubmission(hash) {
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transactionBase64, 'base64'));
  if (hash) tx.message.recentBlockhash = hash;
  tx.sign([owner, collection]);
  const bytes = Buffer.from(tx.serialize()).toString('base64');
  return { tx, bytes, ...inspectSignedDeploymentTransaction(bytes), params: [bytes, {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: 9 }] };
}

test('submission is opt-in, validates all signatures/intent/options, and never relaxes the default read gateway', async () => {
  const item = signedSubmission(), disabled = harness(), h = harness({ allowSubmission: true });
  assert.equal((await disabled.call('sendTransaction', item.params)).status, 400); assert.equal(disabled.calls.length, 0);
  for (const params of [[plan.steps[0].transactionBase64, item.params[1]],
    ...[{ maxRetries: 1 }, { skipPreflight: true }, { preflightCommitment: 'processed' }, { minContextSlot: -1 }]
      .map(config => [item.bytes, { ...item.params[1], ...config }])])
    assert.equal((await h.call('sendTransaction', params)).status, 400);
  item.tx.message.compiledInstructions[0].data[0] ^= 1; item.tx.sign([owner, collection]);
  assert.equal((await h.call('sendTransaction', [Buffer.from(item.tx.serialize()).toString('base64'), item.params[1]])).status, 400);
  assert.equal(h.calls.length, 0); assert.equal(h.storage.values.size, 0);
});

test('permanent gateway claim precedes submission and blocks new hashes/restarts; claimed signatures allow bounded recovery', async () => {
  const item = signedSubmission(); let h;
  h = harness({ allowSubmission: true, responder: async rpc => {
    if (rpc.method === 'sendTransaction') {
      assert.equal([...h.storage.values.keys()].filter(key => key.startsWith('deployment-send:')).length, 1);
      assert.deepEqual(rpc.params, item.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: item.signature }));
    }
  } });
  assert.equal((await h.call('sendTransaction', item.params)).status, 200);
  assert.deepEqual(h.calls.map(call => call.method), ['getGenesisHash', 'getGenesisHash', 'sendTransaction']);
  h.restart(); h.advance(86400000);
  for (const params of [item.params, signedSubmission(key('fresh-hash').publicKey.toBase58()).params]) {
    const result = await h.call('sendTransaction', params);
    assert.equal(result.status, 409); assert.equal(await category(result), 'ALREADY_CLAIMED');
  }
  assert.equal(h.calls.length, 3);
  assert.equal((await h.call('getSignatureStatuses', [[item.signature], { searchTransactionHistory: true }])).status, 200);
  assert.equal((await h.call('getTransaction', [item.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])).status, 200);
  const before = h.calls.length;
  assert.equal((await h.call('getTransaction', [signedSubmission(key('other-hash').publicKey.toBase58()).signature,
    { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])).status, 400);
  assert.equal(h.calls.length, before);
  assert.equal(h.calls.filter(call => call.method === 'sendTransaction').length, 1);
});

test('ambiguous gateway submission, concurrent requests and failed claim storage never release the permanent lock', async () => {
  const item = signedSubmission();
  for (const mode of ['lost', '429', 'wrong-signature']) {
    const h = harness({ allowSubmission: true, responder: rpc => {
      if (rpc.method !== 'sendTransaction') return;
      if (mode === 'lost') throw Error(secret);
      if (mode === '429') return new Response(secret, { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: 'wrong' }));
    } });
    const results = await Promise.all([h.call('sendTransaction', item.params), h.call('sendTransaction', item.params)]);
    assert.ok(results.every(result => result.status >= 400)); h.restart(); h.advance(50000);
    assert.equal((await h.call('sendTransaction', item.params)).status, 409);
    assert.equal(h.calls.filter(call => call.method === 'sendTransaction').length, 1);
  }
  const failed = harness({ allowSubmission: true, storage: { async transaction() { throw Error(secret); } } });
  assert.equal((await failed.call('sendTransaction', item.params)).status, 503); assert.equal(failed.calls.length, 0);
});
