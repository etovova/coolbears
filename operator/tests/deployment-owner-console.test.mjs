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
import { readDeploymentJournal, appendDeploymentEvent } from '../deployment/journal.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { createOwnerClient, compatibleOwnerWallet } from '../deployment/owner-console/client.mjs';
import { networkProfile } from '../deployment/network.mjs';
import { insertionAccounts } from './fixtures/group-accounts.mjs';
import { seedVerifiedPrefix } from './fixtures/group-journal.mjs';
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
const fixtures = new Map();
let prepareDeploymentSigning, startSigningConsole, runOwnerConsole, createSigningSession, prepareDeploymentGroup;
before(async () => {
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = () => assert.fail('Unstubbed network');
  // The native account verifier intentionally snapshots its immutable policy.
  // Install this test's synthetic owner before loading that production module.
  ({ prepareDeploymentSigning } = await import('../deployment/handoff.mjs'));
  ({ startSigningConsole } = await import('../deployment/owner-console/server.mjs'));
  ({ runOwnerConsole } = await import('../deployment/owner-console/cli.mjs'));
  ({ createSigningSession } = await import('../deployment/owner-console/session.mjs'));
  ({ prepareDeploymentGroup } = await import('../deployment/group.mjs'));
  for (const cluster of ['devnet', 'mainnet-beta']) fixtures.set(cluster,
    await createDeploymentSignerVault({ id: `owner-console-${cluster}-fixture`, cluster,
      blockhash: key('hash').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000', passphrase }));
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
function rpc(cluster = 'devnet', manifest) {
  const calls = []; let fail = false, genesis = GENESIS_HASHES[cluster];
  return { calls, block: () => { fail = true; }, wrongGenesis: () => { genesis = GENESIS_HASHES.devnet; }, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const request = JSON.parse(init.body); calls.push(request.method);
    const result = { getGenesisHash: genesis,
      getMultipleAccounts: { context: { slot: 510 }, value: manifest ? insertionAccounts(manifest) : [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
      getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
      getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('fresh').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 513 }, value: 10000 },
      isBlockhashValid: { context: { slot: 514 }, value: !fail }, getBlockHeight: 1500,
      simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    }[request.method];
    if (manifest && result?.context) result.context.slot = 600;
    assert.notEqual(result, undefined);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } };
}
async function harness(t, start = true, cluster = 'devnet', groupCount = 0) {
  const parent = await mkdtemp(path.join(tmpdir(), 'owner-console-'));
  const directory = path.join(parent, 'bundle');
  const fixture = fixtures.get(cluster);
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  if (groupCount) await seedVerifiedPrefix({ fixture, passphrase, owner, journalDirectory });
  for (const name of ['index.html', 'style.css', 'app.js']) await writeFile(path.join(parent, name), name);
  const upstream = rpc(cluster, groupCount ? fixture.manifest : undefined);
  let prepared;
  try {
    prepared = groupCount ? await prepareDeploymentGroup({ directory, count: groupCount, endpoint, fetchImpl: upstream.fetchImpl,
      authorizeMainnet: cluster === 'mainnet-beta' })
      : await prepareDeploymentSigning({ directory, stepId, passphrase, endpoint, fetchImpl: upstream.fetchImpl,
        authorizeMainnet: cluster === 'mainnet-beta' });
  } catch (error) {
    if (groupCount) console.error(JSON.stringify({ fixture: 'owner-group-preflight', cluster, rpcMethods: upstream.calls }));
    throw error;
  }
  const options = { directory, endpoint, fetchImpl: upstream.fetchImpl, port: 0, assetsDirectory: pathToFileURL(parent + '/'),
    authorizeMainnetSigning: cluster === 'mainnet-beta' };
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
function wallet(events, mode = 'normal', cluster = 'devnet') {
  const chain = networkProfile(cluster).walletChain;
  const account = { address: owner.publicKey.toBase58(), publicKey: owner.publicKey.toBytes(), chains: [chain], features: ['solana:signTransaction'] };
  let changed;
  const value = { name: 'Fixture Wallet', chains: [chain], accounts: [account], features: {
    'standard:connect': { async connect() { events.push('connect'); return { accounts: value.accounts }; } },
    'standard:events': { on(_name, callback) { changed = callback; return () => {}; } },
    'solana:signAndSendTransaction': { signAndSendTransaction() { assert.fail('Broadcast forbidden'); } },
    'solana:signTransaction': { supportedTransactionVersions: [0], async signTransaction(...inputs) {
      events.push('wallet-sign');
      if (mode === 'cancel') throw Object.assign(Error(), { code: 4001 });
      if (mode === 'unknown') throw Error('Disconnected');
      return inputs.map(input => {
        assert.equal(input.chain, chain); assert.equal(input.account, account);
        const tx = VersionedTransaction.deserialize(input.transaction);
        if (mode === 'changed') tx.message.recentBlockhash = key('changed').publicKey.toBase58();
        tx.sign([owner]);
        if (mode === 'cleared') tx.signatures[1].fill(0);
        return { signedTransaction: tx.serialize() };
      });
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

test('Mainnet session and CLI require a distinct grant before RPC or wallet claims; invalid flags cannot authorize it', async t => {
  const h = await harness(t, false, 'mainnet-beta'), before = await h.snapshot(), calls = h.upstream.calls.length;
  for (const authorizeMainnetSigning of [undefined, false, 'true', 1]) {
    await assert.rejects(createSigningSession({ ...h.options, authorizeMainnetSigning }),
      error => error.code === 'MAINNET_SIGN_AUTHORIZATION');
  }
  await assert.rejects(startSigningConsole({ ...h.options, authorizeMainnetSigning: false }),
    error => error.code === 'MAINNET_SIGN_AUTHORIZATION');
  for (const args of [
    ['prepare-next', h.directory],
    ['prepare-next', h.directory, '--devnet-send'],
    ['prepare-next', h.directory, '--devnet-sign'],
    ['prepare-next', h.directory, '--mainnet-sign', '--mainnet-sign'],
    ['prepare-next', h.directory, '--mainnet-sign', '--devnet-send'],
    ['prepare-group', h.directory, '2'],
    ['serve', h.directory],
    ['import-response', h.directory, '/missing-response', '--devnet-send'],
  ]) {
    let message = '';
    assert.equal(await runOwnerConsole(args, { input: { isTTY: false }, output: { write: () => {} },
      errorOutput: { write: value => { message += value; } }, env: {} }), 1);
    assert.match(message, /stopped/);
  }
  assert.equal(h.upstream.calls.length, calls); assert.deepEqual(await h.snapshot(), before);
  const state = await (await createSigningSession(h.options)).state();
  assert.equal(state.cluster, 'mainnet-beta'); assert.equal(state.walletChain, 'solana:mainnet');
  const devnet = await harness(t, false);
  await assert.rejects(createSigningSession({ ...devnet.options, authorizeMainnetSigning: true }),
    error => error.code === 'MAINNET_SIGN_AUTHORIZATION');
});

for (const groupCount of [0, 2]) test(`Mainnet owner ${groupCount ? 'insertion group' : 'single request'} uses the journal network, sign-only wallet API and cluster-bound recovery`, async t => {
    const h = await harness(t, true, 'mainnet-beta', groupCount), client = createOwnerClient(h);
    await client.load();
    assert.equal(client.state().cluster, 'mainnet-beta');
    assert.equal(compatibleOwnerWallet(wallet([]).value, 'mainnet-beta'), false);
    assert.equal(compatibleOwnerWallet(wallet([], 'normal', 'mainnet-beta').value, 'mainnet-beta'), true);
    await assert.rejects(client.connect(wallet(h.events).value), error => error.code === 'WALLET_UNSUPPORTED');
    await client.connect(wallet(h.events, 'normal', 'mainnet-beta').value);
    await client.sign();
    assert.equal(h.events.filter(value => value === 'wallet-sign').length, 1);
    assert.ok(!h.upstream.calls.includes('sendTransaction'));
    const response = client.exportResponse(); assert.equal(response.cluster, 'mainnet-beta');
    const signed = await h.snapshot(); await h.restart();
    const restarted = createOwnerClient(h); await restarted.load(); await restarted.recover();
    assert.deepEqual(await h.snapshot(), signed); assert.equal(h.events.filter(value => value === 'wallet-sign').length, 1);
    const responsePath = path.join(path.dirname(h.directory), 'mainnet-response.PRIVATE.json');
    await writeFile(responsePath, JSON.stringify(response), { mode: 0o600 });
    let report = '';
    assert.equal(await runOwnerConsole(['import-response', h.directory, responsePath], {
      output: { write: () => assert.fail('Missing Mainnet grant') }, errorOutput: { write: () => {} }, env: {} }), 1);
    assert.equal(await runOwnerConsole(['import-response', h.directory, responsePath, '--mainnet-sign'], {
      output: { write: value => { report += value; } }, errorOutput: { write: () => assert.fail('Mainnet recovery failed') }, env: {} }), 0);
    assert.equal(JSON.parse(report).cluster, 'mainnet-beta'); assert.equal(JSON.parse(report).alreadySaved, true);
    await writeFile(responsePath, JSON.stringify({ ...response, cluster: 'devnet' }), { mode: 0o600 });
    assert.equal(await runOwnerConsole(['import-response', h.directory, responsePath, '--mainnet-sign'], {
      output: { write: () => assert.fail('Wrong network import') }, errorOutput: { write: () => {} }, env: {} }), 1);
    assert.deepEqual(await h.snapshot(), signed);
});

test('forged state, preflight and stored network labels never reach a Mainnet wallet', async t => {
  const h = await harness(t, false, 'mainnet-beta'), session = await createSigningSession(h.options), view = await session.state();
  const basicStorage = { ready: async () => {}, get: async () => null, put: async () => assert.fail('Unexpected persistence') };
  const unknown = createOwnerClient({ api: async () => ({ ...view, cluster: 'testnet' }), storage: basicStorage });
  await assert.rejects(unknown.load(), error => error.code === 'STATE');
  const missingChain = createOwnerClient({ api: async () => ({ ...view, walletChain: undefined }), storage: basicStorage });
  await assert.rejects(missingChain.load(), error => error.code === 'STATE');
  for (const mutate of [checked => ({ ...checked, cluster: 'devnet' }),
    checked => ({ ...checked, walletChain: 'solana:devnet' }),
    checked => ({ ...checked, request: { ...checked.request, cluster: 'devnet' } })]) {
    const events = [], client = createOwnerClient({ api: async route => route === '/api/state' ? view : mutate({ ...view,
      request: h.prepared.request, simulationVerified: true, claimId: 'c'.repeat(64), expiresAt: Date.now() + 20000 }), storage: basicStorage });
    await client.load(); await client.connect(wallet(events, 'normal', 'mainnet-beta').value);
    await assert.rejects(client.sign()); assert.ok(!events.includes('wallet-sign'));
  }
  const wrongRecord = createOwnerClient({ api: async () => view, storage: { ...basicStorage,
    get: async () => ({ requestId: view.requestId, request: h.prepared.request, cluster: 'devnet', status: 'wallet-pending' }) } });
  await assert.rejects(wrongRecord.load(), error => error.code === 'REQUEST_CHANGED');
  h.upstream.wrongGenesis();
  await assert.rejects(session.check(view.requestId), error => error.code === 'PREFLIGHT_BLOCKED');
  assert.equal((await h.snapshot()).revision, 1);
});

test('Mainnet wallet change during durable intent persistence blocks signing and retains its consumed claim', async t => {
  const h = await harness(t, true, 'mainnet-beta'), w = wallet(h.events, 'normal', 'mainnet-beta');
  const storage = { ...h.storage, async put(id, value) {
    await h.storage.put(id, value);
    if (value.status === 'wallet-pending') w.change();
  } };
  const client = createOwnerClient({ api: h.api, storage });
  await client.load(); await client.connect(w.value);
  await assert.rejects(client.sign(), error => error.code === 'WALLET_CHANGED');
  assert.equal(h.events.includes('wallet-sign'), false); assert.equal(h.events.includes('/api/decline'), false);
  const saved = await h.snapshot(), attempt = saved.steps[0].attempts[0];
  assert.equal(saved.revision, 2); assert.equal(attempt.state, 'wallet-pending');
  assert.match(attempt.walletClaim, /^[a-f0-9]{64}$/); assert.equal(attempt.signed, null);
  assert.equal(h.values.get(client.state().requestId).status, 'wallet-pending');
  const restarted = createOwnerClient(h); await restarted.load();
  await restarted.connect(wallet(h.events, 'normal', 'mainnet-beta').value);
  assert.equal(restarted.state().canSign, false); await assert.rejects(restarted.sign(), error => error.code === 'NOT_READY');
  assert.deepEqual(await h.snapshot(), saved); assert.equal(h.events.includes('wallet-sign'), false);
});
