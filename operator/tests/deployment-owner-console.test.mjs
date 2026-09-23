// Private loopback server + journal + Wallet Standard client, with test keys/RPC.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { prepareDeploymentSigning } from '../deployment/handoff.mjs';
import { readDeploymentJournal, appendDeploymentEvent } from '../deployment/journal.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { startSigningConsole } from '../deployment/owner-console/server.mjs';
import { runOwnerConsole } from '../deployment/owner-console/cli.mjs';
import { createSigningSession } from '../deployment/owner-console/session.mjs';
import { createOwnerClient, compatibleOwnerWallet } from '../deployment/owner-console/client.mjs';
const key = n => Keypair.fromSeed(createHash('sha256').update(`owner-console-${n}`).digest());
const owner = key('owner'), passphrase = Buffer.from('owner-console-fixture-passphrase');
const endpoint = 'https://private-rpc.test/?key=PRIVATE_SENTINEL', stepId = 'collection-create';
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
function networkFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(Error('Local HTTP timeout'))); req.end(init.body);
  });
}
let fixture;
before(async () => {
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = () => assert.fail('Unstubbed network');
  fixture = await createDeploymentSignerVault({ id: 'owner-console-fixture', cluster: 'devnet',
    blockhash: key('hash').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000', passphrase });
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
function rpc() {
  const calls = []; let fail = false;
  return { calls, block: () => { fail = true; }, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const request = JSON.parse(init.body); calls.push(request.method);
    const result = { getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
      getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
      getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('fresh').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 513 }, value: 10000 },
      isBlockhashValid: { context: { slot: 514 }, value: !fail }, getBlockHeight: 1500,
      simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    }[request.method];
    assert.notEqual(result, undefined);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } };
}
async function harness(t, start = true) {
  const parent = await mkdtemp(path.join(tmpdir(), 'owner-console-'));
  const directory = path.join(parent, 'bundle');
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  for (const name of ['index.html', 'style.css', 'app.js']) await writeFile(path.join(parent, name), name);
  const upstream = rpc();
  const prepared = await prepareDeploymentSigning({ directory, stepId, passphrase, endpoint, fetchImpl: upstream.fetchImpl });
  const options = { directory, endpoint, fetchImpl: upstream.fetchImpl, port: 0, assetsDirectory: pathToFileURL(parent + '/') };
  let server = start ? await startSigningConsole(options) : null;
  t.after(async () => { await server?.close(); await rm(parent, { recursive: true, force: true }); });
  const events = [], values = new Map();
  const storage = { ready: async () => {}, get: async key => structuredClone(values.get(key)), put: async (key, value) => { events.push(`store:${value.status}`); values.set(key, structuredClone(value)); } };
  let loseAck = false;
  const api = async (route, body) => {
    events.push(route);
    const response = await networkFetch(server.origin + route, { method: body ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${server.url.split('#')[1]}`, ...(body ? { origin: server.origin, 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (!response.ok) throw Object.assign(Error('API'), { code: data.code });
    if (loseAck && route === '/api/signature') throw Error('Lost acknowledgement');
    return data;
  };
  return { directory, journalDirectory, upstream, prepared, options, values, storage, api, events,
    get server() { return server; }, loseAck: value => { loseAck = value; },
    restart: async () => { await server.close(); server = await startSigningConsole(options); },
    snapshot: () => readDeploymentJournal(journalDirectory),
  };
}
function wallet(events, mode = 'normal') {
  const account = { address: owner.publicKey.toBase58(), publicKey: owner.publicKey.toBytes(), chains: ['solana:devnet'], features: ['solana:signTransaction'] };
  let changed;
  const value = { name: 'Fixture Wallet', chains: ['solana:devnet'], accounts: [account], features: {
    'standard:connect': { async connect() { events.push('connect'); return { accounts: value.accounts }; } },
    'standard:events': { on(_name, callback) { changed = callback; return () => {}; } },
    'solana:signAndSendTransaction': { signAndSendTransaction() { assert.fail('Broadcast forbidden'); } },
    'solana:signTransaction': { supportedTransactionVersions: [0], async signTransaction(input) {
      events.push('wallet-sign'); assert.equal(input.chain, 'solana:devnet'); assert.equal(input.account, account);
      if (mode === 'cancel') throw Object.assign(Error(), { code: 4001 });
      if (mode === 'unknown') throw Error('Disconnected');
      const tx = VersionedTransaction.deserialize(input.transaction);
      if (mode === 'changed') tx.message.recentBlockhash = key('changed').publicKey.toBase58();
      tx.sign([owner]);
      if (mode === 'cleared') tx.signatures[1].fill(0);
      return [{ signedTransaction: tx.serialize() }];
    } },
  } };
  return { value, change() { value.accounts = []; changed?.({ accounts: [] }); } };
}

test('loopback HTTP restricts Host, Origin, token, methods and body; static assets have CSP and no private data', async t => {
  const h = await harness(t), origin = h.server.origin, token = h.server.url.split('#')[1];
  const html = await networkFetch(origin + '/'); assert.equal(html.status, 200);
  assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(html.headers.get('cache-control'), 'no-store'); assert.ok(!(await html.text()).includes(token));
  for (const [headers, status] of [[{}, 401], [{ authorization: 'Bearer wrong' }, 401],
    [{ authorization: `Bearer ${token}`, origin: 'https://evil.test' }, 403],
    [{ authorization: `Bearer ${token}`, host: 'evil.test' }, 403],
    [{ authorization: `Bearer ${token}`, cookie: 'x=1' }, 403],
    [{ authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' }, 403]]) {
    assert.equal((await networkFetch(origin + '/api/state', { headers })).status, status);
  }
  const oversized = await networkFetch(origin + '/api/signature', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: 'x'.repeat(4097) });
  assert.equal(oversized.status, 400);
  assert.equal((await networkFetch(origin + '/vault.json')).status, 404);
  assert.equal((await networkFetch(origin + '/api/state?token=' + token)).status, 404);
  assert.equal(h.upstream.calls.length, 12); assert.equal((await h.snapshot()).revision, 1);
});

test('owner client saves intent before wallet and signed bytes before POST; lost ack and server restart are idempotent', async t => {
  const h = await harness(t), w = wallet(h.events), client = createOwnerClient(h);
  await client.load(); assert.equal(h.events.includes('wallet-sign'), false);
  await client.connect(w.value); h.loseAck(true);
  await assert.rejects(client.sign());
  const snapshot = await h.snapshot(); assert.equal(snapshot.revision, 3); assert.equal(snapshot.steps[0].attempts[0].state, 'signed');
  assert.ok(h.events.indexOf('store:wallet-pending') < h.events.indexOf('wallet-sign'));
  assert.ok(h.events.indexOf('store:signed') < h.events.indexOf('/api/signature'));
  assert.equal(client.state().canRecover, true); assert.equal(client.state().canSign, false);
  h.loseAck(false); await h.restart(); const resumed = createOwnerClient(h); await resumed.load();
  assert.equal(resumed.state().signed, true); await resumed.recover();
  assert.equal((await h.snapshot()).revision, 3); assert.equal(h.events.filter(value => value === 'wallet-sign').length, 1);
  assert.equal(h.upstream.calls.filter(value => value === 'simulateTransaction').length, 2);
  assert.equal(resumed.exportResponse().transactionBase64, snapshot.steps[0].attempts[0].signed.transactionBase64);
  const responsePath = path.join(path.dirname(h.directory), 'response.PRIVATE.json');
  await writeFile(responsePath, JSON.stringify(resumed.exportResponse()), { mode: 0o600 });
  let report = '';
  assert.equal(await runOwnerConsole(['import-response', h.directory, responsePath], {
    output: { write: value => { report += value; } }, errorOutput: { write: () => assert.fail('Import error') }, env: {} }), 0);
  assert.equal(JSON.parse(report).alreadySaved, true); assert.equal((await h.snapshot()).revision, 3);
});

test('failed fresh preflight, wrong owner and unavailable browser persistence never open signing', async t => {
  const h = await harness(t), w = wallet(h.events); const client = createOwnerClient(h); await client.load();
  const wrong = wallet(h.events); wrong.value.accounts = [{ ...wrong.value.accounts[0], address: key('stranger').publicKey.toBase58() }];
  await assert.rejects(client.connect(wrong.value), error => error.code === 'WRONG_WALLET');
  await client.connect(w.value); h.upstream.block();
  await assert.rejects(client.sign(), error => error.code === 'PREFLIGHT_BLOCKED');
  assert.equal(h.events.includes('wallet-sign'), false); assert.equal((await h.snapshot()).revision, 1);
  const noStorage = createOwnerClient({ api: h.api, storage: { ready: async () => {}, get: async () => null, put: async () => { throw Error('Quota'); } } });
  await noStorage.load(); await noStorage.connect(w.value);
  // Use a successful saved check fixture solely to reach the storage gate.
  const view = await h.api('/api/state');
  const mocked = createOwnerClient({ api: async route => route === '/api/state' ? view : { ...view, request: h.prepared.request, simulationVerified: true, claimId: 'c'.repeat(64), expiresAt: Date.now() + 20000 },
    storage: { ready: async () => {}, get: async () => null, put: async () => { throw Error('Quota'); } } });
  await mocked.load(); await mocked.connect(w.value); await assert.rejects(mocked.sign()); assert.equal(h.events.includes('wallet-sign'), false);
});

test('wallet rejection can be retried explicitly; unknown response survives reload and blocks a new signature', async t => {
  const h = await harness(t);
  const client = createOwnerClient(h); await client.load(); await client.connect(wallet(h.events, 'cancel').value);
  await assert.rejects(client.sign(), error => error.code === 'WALLET_CANCELLED'); assert.equal(client.state().canSign, true);
  await client.connect(wallet(h.events, 'unknown').value); await assert.rejects(client.sign(), error => error.code === 'WALLET_UNKNOWN');
  const resumed = createOwnerClient(h); await resumed.load(); await resumed.connect(wallet(h.events).value);
  assert.equal(resumed.state().canSign, false); await assert.rejects(resumed.sign());
  assert.equal(h.events.filter(value => value === 'wallet-sign').length, 2); assert.equal((await h.snapshot()).revision, 4);
});

test('altered wallet bytes or erased partial signatures never reach the journal', async t => {
  for (const mode of ['changed', 'cleared']) {
    const h = await harness(t);
    const isolated = { api: h.api, storage: { ready: async () => {}, get: async () => null, put: async () => {} } };
    const client = createOwnerClient(isolated); await client.load(); await client.connect(wallet(h.events, mode).value);
    await assert.rejects(client.sign());
    assert.equal(h.events.filter(value => value === '/api/signature').length, 0); assert.equal((await h.snapshot()).revision, 2);
  }
});

test('session binds one saved request and accepts late valid bytes in unknown state without another RPC', async t => {
  const h = await harness(t, false), session = await createSigningSession(h.options), state = await session.state();
  const before = await h.snapshot();
  await appendDeploymentEvent(h.journalDirectory, { type: 'unknown', stepId, attempt: 1 }, { expectedRevision: before.revision });
  const tx = VersionedTransaction.deserialize(Buffer.from(h.prepared.request.transactionBase64, 'base64')); tx.sign([owner]);
  await assert.rejects(session.check(state.requestId), error => error.code === 'ALREADY_HANDLED');
  await assert.rejects(session.accept('0'.repeat(64), Buffer.from(tx.serialize()).toString('base64')));
  const result = await session.accept(state.requestId, Buffer.from(tx.serialize()).toString('base64'));
  assert.equal(result.state, 'unknown'); assert.equal(result.signed, true); assert.equal(h.upstream.calls.length, 12);
  assert.equal((await h.snapshot()).revision, 3);
});

test('only explicit Devnet v0 signTransaction wallets are eligible', () => {
  const value = wallet([]).value; assert.equal(compatibleOwnerWallet(value), true);
  for (const mutate of [w => { delete w.features['solana:signTransaction']; }, w => { w.chains = ['solana:mainnet']; },
    w => { w.features['solana:signTransaction'].supportedTransactionVersions = ['legacy']; }]) {
    const candidate = wallet([]).value; mutate(candidate); assert.ok(!compatibleOwnerWallet(candidate));
  }
});


test('durable wallet claim blocks a second server/profile and survives restart; only matching explicit decline releases it', async t => {
  const h = await harness(t, false), first = await createSigningSession(h.options), second = await createSigningSession(h.options);
  const state = await first.state();
  const results = await Promise.allSettled([first.check(state.requestId), second.check(state.requestId)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const claimed = results.find(value => value.status === 'fulfilled').value;
  assert.equal((await h.snapshot()).revision, 2);
  const restarted = await createSigningSession(h.options); assert.equal((await restarted.state()).walletRequested, true);
  const calls = h.upstream.calls.length;
  await assert.rejects(restarted.check(state.requestId)); assert.equal(h.upstream.calls.length, calls);
  await assert.rejects(restarted.decline(state.requestId, '0'.repeat(64)));
  const snap = await h.snapshot();
  await assert.rejects(appendDeploymentEvent(h.journalDirectory, { type: 'cancelled', stepId, attempt: 1 }, { expectedRevision: snap.revision }));
  assert.equal((await restarted.decline(state.requestId, claimed.claimId)).walletRequested, false);
  assert.equal((await h.snapshot()).revision, 3);
});
