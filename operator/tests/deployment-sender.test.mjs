// Canonical full plan, disposable keys and real journals; all HTTP intercepted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer, getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, readDeploymentJournal } from '../deployment/journal.mjs';
import { verifySigningResponse } from '../deployment/signing.mjs';
import { createDeploymentRpc, GENESIS_HASHES } from '../deployment/rpc.mjs';
import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { makeGateway } from '../deployment/gateway/worker.mjs';
import { createGatewayFetch } from '../deployment/gateway/client.mjs';
const key = n => Keypair.fromSeed(createHash('sha256').update(`sender-fixture-${n}`).digest());
const owner = key('owner'), passphrase = Buffer.from('sender-fixture-private-password');
const endpoint = 'https://sender.test/rpc', stepId = 'collection-create';
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
let fixture, request, signed, sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep, runDeploymentSenderCli;
before(async () => {
  policy.owner = owner.publicKey.toBase58(); globalThis.fetch = () => assert.fail('Unstubbed HTTP forbidden');
  // The account verifier snapshots the approved owner on import. Load it after
  // installing this worker's disposable policy, as in deployment-read tests.
  ({ sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep } = await import('../deployment/sender.mjs'));
  ({ runDeploymentSenderCli } = await import('../deployment/send-cli.mjs'));
  fixture = await createDeploymentSignerVault({ id: 'sender-fixture', cluster: 'devnet', blockhash: key('hash').publicKey.toBase58(),
    lastValidBlockHeight: 2000, machineRentLamports: '5000000000', passphrase });
  const vault = await openDeploymentSignerVault({ ...fixture, passphrase });
  try {
    request = await vault.partialSign({ stepId, transactionBase64: fixture.manifest.steps[0].transactionBase64,
      lastValidBlockHeight: 2000, attempt: 1 });
  } finally { vault.dispose(); }
  // partialSign returns the canonical request.
  const tx = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64')); tx.sign([owner]);
  signed = verifySigningResponse(request, { transactionBase64: Buffer.from(tx.serialize()).toString('base64') });
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
async function harness(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-sender-')), directory = path.join(parent, 'bundle');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  await appendDeploymentEvent(journalDirectory, { type: 'prepare', stepId, request, retry: false }, { expectedRevision: 0 });
  await appendDeploymentEvent(journalDirectory, { type: 'signed', stepId, attempt: 1, transactionBase64: signed.transactionBase64 }, { expectedRevision: 1 });
  return { directory, journalDirectory, snapshot: () => readDeploymentJournal(journalDirectory) };
}
function collectionAccount() {
  const expected = fixture.manifest.steps[0].expected;
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1, updateAuthority: policy.owner,
    name: expected.name, uri: expected.uri, numMinted: 0, currentSize: 0 });
  const royalty = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{ basisPoints: 700,
    creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] });
  const offset = base.length + 9;
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: offset + royalty.length });
  const registry = getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1,
    registry: [{ pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset }], externalRegistry: [] });
  const data = Buffer.concat([base, header, royalty, registry]);
  return { data: [data.toString('base64'), 'base64'], executable: false, lamports: 2000000, owner: MPL_CORE_PROGRAM_ID, rentEpoch: 0, space: data.length };
}
function upstream({ completed = false, override = {}, onCall } = {}) {
  const calls = [];
  const results = { getGenesisHash: GENESIS_HASHES.devnet,
    getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, completed ? collectionAccount() : null, null, null, null] },
    getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
    getFeeForMessage: { context: { slot: 513 }, value: 10000 },
    isBlockhashValid: { context: { slot: 514 }, value: true }, getBlockHeight: 1500,
    simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    sendTransaction: signed.signature,
    getSignatureStatuses: { context: { slot: 509 }, value: [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }] },
    getTransaction: { slot: 500, version: 0, meta: { err: null }, transaction: [signed.transactionBase64, 'base64'] }, ...override };
  return { calls, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const rpc = JSON.parse(init.body); calls.push(rpc);
    const response = await onCall?.(rpc, results);
    if (response) return response;
    assert.ok(Object.hasOwn(results, rpc.method), rpc.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] }));
  } };
}
const send = (h, rpc, extra = {}) => sendDeploymentStep({ directory: h.directory, stepId, endpoint,
  fetchImpl: rpc.fetchImpl, authorizeDevnetSend: true, ...extra });
const resume = (h, rpc) => resumeDeploymentStep({ directory: h.directory, stepId, endpoint, fetchImpl: rpc.fetchImpl });

test('one exact saved transaction: fresh simulation, durable claim, matching acknowledgment, finalized account verification', async t => {
  const h = await harness(t), rpc = upstream({ onCall: async call => {
    if (call.method === 'sendTransaction') {
      const snap = await h.snapshot(); assert.equal(snap.revision, 3); assert.equal(snap.steps[0].attempts[0].state, 'send-claimed');
      assert.deepEqual(call.params, [signed.transactionBase64, { encoding: 'base64', skipPreflight: false,
        preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: 514 }]);
    }
  } });
  const result = await send(h, rpc); assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.chainVerified, false); assert.equal(result.transactionsSent, null); assert.equal(result.submissionAttempts, 1);
  const simulation = rpc.calls.find(call => call.method === 'simulateTransaction');
  assert.equal(simulation.params[0], signed.transactionBase64); assert.equal(simulation.params[1].sigVerify, true);
  assert.equal(rpc.calls.filter(call => call.method === 'sendTransaction').length, 1);
  assert.equal(rpc.calls.some(call => call.method === 'getLatestBlockhash'), false);
  assert.equal((await h.snapshot()).revision, 4);
  const missing = upstream({ override: { getTransaction: null } });
  assert.equal((await resume(h, missing)).status, 'unknown'); assert.equal((await h.snapshot()).revision, 4);
  assert.equal((await send(h, missing)).status, 'blocked');
  const recovered = await resume(h, upstream({ completed: true }));
  assert.equal(recovered.status, 'verified', JSON.stringify(recovered)); assert.equal(recovered.journalWrites, 1); assert.equal(recovered.salesOpen, false);
  const repeatRpc = upstream(), repeat = await resume(h, repeatRpc);
  assert.equal(repeat.status, 'already-recorded'); assert.equal(repeatRpc.calls.length, 0); assert.equal((await h.snapshot()).revision, 5);
});

test('lost response, HTTP 429, wrong signature and lost journal acknowledgment never cause a second submission', async t => {
  for (const mode of ['lost', '429', 'signature', 'disk']) {
    const h = await harness(t), rpc = upstream({ onCall: async call => {
      if (call.method !== 'sendTransaction') return;
      if (mode === 'lost') throw Error('PRIVATE_SENTINEL');
      if (mode === '429') return new Response('PRIVATE_SENTINEL', { status: 429 });
      if (mode === 'signature') return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: 'wrong' }));
      await mkdir(path.join(h.journalDirectory, '.writer-lock'), { mode: 0o700 });
    } });
    const first = await send(h, rpc); assert.equal(first.status, 'unknown'); assert.equal(first.submissionAttempts, 1);
    assert.ok(!JSON.stringify(first).includes('PRIVATE_SENTINEL'));
    assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'send-claimed');
    if (mode === 'disk') await rm(path.join(h.journalDirectory, '.writer-lock'), { recursive: true }); // test-owned lock only
    assert.equal((await send(h, rpc)).status, 'blocked');
    assert.equal(rpc.calls.filter(call => call.method === 'sendTransaction').length, 1);
    const recovery = await resume(h, upstream({ completed: true })); assert.equal(recovery.status, 'verified', JSON.stringify(recovery));
  }
});

test('explicit authorization, correct network, valid hash and successful signed simulation are required before claim', async t => {
  const h = await harness(t);
  const none = upstream(); assert.equal((await send(h, none, { authorizeDevnetSend: false })).code, 'EXPLICIT_SEND_REQUIRED'); assert.equal(none.calls.length, 0);
  for (const override of [{ getGenesisHash: GENESIS_HASHES['mainnet-beta'] },
    { isBlockhashValid: { context: { slot: 514 }, value: false } },
    { simulateTransaction: { context: { slot: 514 }, value: { err: { InstructionError: [0, 'InvalidArgument'] }, unitsConsumed: 1 } } }]) {
    const rpc = upstream({ override }); assert.equal((await send(h, rpc)).status, 'blocked');
    assert.equal(rpc.calls.some(call => call.method === 'sendTransaction'), false); assert.equal((await h.snapshot()).revision, 2);
  }
});

test('concurrent senders can both inspect but only one can persist the claim and submit', async t => {
  const h = await harness(t), rpc = upstream();
  const results = await Promise.all([send(h, rpc), send(h, rpc)]);
  assert.equal(results.filter(value => value.status === 'accepted').length, 1, JSON.stringify(results));
  assert.equal(rpc.calls.filter(call => call.method === 'sendTransaction').length, 1);
  assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'accepted');
});

test('journal movement during simulation and reconciliation cannot be overwritten by stale work', async t => {
  const h = await harness(t);
  const move = async () => {
    const snap = await h.snapshot(); await appendDeploymentEvent(h.journalDirectory, { type: 'unknown', stepId, attempt: 1 }, { expectedRevision: snap.revision });
  };
  const sending = upstream({ onCall: async call => { if (call.method === 'simulateTransaction') await move(); } });
  assert.equal((await send(h, sending)).status, 'blocked'); assert.equal(sending.calls.some(call => call.method === 'sendTransaction'), false);
  const reconciling = upstream({ completed: true, onCall: async call => { if (call.method === 'getMultipleAccounts') await move(); } });
  assert.equal((await resume(h, reconciling)).status, 'unknown');
  assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'unknown');
});

test('exact transport grant requires Devnet and safe options; one attempt stays consumed after an ambiguous response', async () => {
  const grant = { transactionBase64: signed.transactionBase64, minContextSlot: 514 };
  const params = [signed.transactionBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: 514 }];
  const rpc = upstream({ onCall: async call => { if (call.method === 'sendTransaction') throw Error('lost'); } });
  const transport = createDeploymentRpc({ endpoint, fetchImpl: rpc.fetchImpl, submission: grant });
  await assert.rejects(transport.call('sendTransaction', params)); assert.equal(rpc.calls.length, 0);
  await transport.call('getGenesisHash');
  for (const config of [{ skipPreflight: true }, { maxRetries: 1 }, { minContextSlot: 513 }, { preflightCommitment: 'processed' }])
    await assert.rejects(transport.call('sendTransaction', [params[0], { ...params[1], ...config }]));
  await assert.rejects(transport.call('sendTransaction', [request.transactionBase64, params[1]]));
  await assert.rejects(transport.call('sendTransaction', params));
  await assert.rejects(transport.call('sendTransaction', params));
  assert.equal(rpc.calls.filter(call => call.method === 'sendTransaction').length, 1);
  const disabled = createDeploymentRpc({ endpoint, fetchImpl: rpc.fetchImpl });
  await assert.rejects(disabled.call('sendTransaction', params));
  const main = upstream({ override: { getGenesisHash: GENESIS_HASHES['mainnet-beta'] } });
  const wrong = createDeploymentRpc({ endpoint, fetchImpl: main.fetchImpl, submission: grant });
  await wrong.call('getGenesisHash'); await assert.rejects(wrong.call('sendTransaction', params));
  assert.equal(main.calls.length, 1);
  assert.throws(() => createDeploymentRpc({ endpoint, submission: { ...grant, transactionBase64: request.transactionBase64 } }));
});

test('CLI requires an explicit single-step flag and private endpoint credentials; errors omit secrets', async () => {
  let output = ''; const write = text => { output += text; };
  assert.equal(await runDeploymentSenderCli(['send-one', '/missing', stepId], { write, env: {} }), 1);
  output = '';
  assert.equal(await runDeploymentSenderCli(['send-one', '/missing', stepId, '--devnet-send'], {
    write, env: { COOLBEARS_RPC_URL: 'https://bad.test/?PRIVATE_SENTINEL', COOLBEARS_OPERATOR_RPC_TOKEN: 'PRIVATE_SENTINEL' } }), 1);
  assert.ok(!output.includes('PRIVATE_SENTINEL'));
});

test('sender through bearer gateway recovers its durable signature after gateway restart without redeployment', async t => {
  const h = await harness(t), compiled = await compileDeploymentRpcPolicy(fixture.manifest, { allowSimulation: true });
  const values = new Map(), storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); }, async transaction(fn) { return fn(this); } };
  const token = 'S'.repeat(43), env = { OPERATOR_RPC_TOKEN: token, HELIUS_API_KEY: 'test-only-secret' };
  const { DeploymentGate, worker } = makeGateway(compiled, { allowSubmission: true });
  let now = 1800000000000, rpc = upstream(), gate;
  function restart() {
    gate = new DeploymentGate({ storage }, env, { clock: () => now, pause: async ms => { now += ms; },
      fetchImpl: (_url, init) => rpc.fetchImpl(endpoint, init) });
  }
  restart(); env.DEPLOYMENT_GATE = { idFromName: name => name, get: () => gate };
  const fetchImpl = createGatewayFetch({ endpoint, token,
    fetchImpl: (url, init) => worker.fetch(new Request(url, init), env) });
  const result = await send(h, { fetchImpl }); assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(rpc.calls.filter(call => call.method === 'sendTransaction').length, 1);
  rpc = upstream({ completed: true }); restart();
  const recovered = await resume(h, { fetchImpl }); assert.equal(recovered.status, 'verified', JSON.stringify(recovered));
  assert.equal(rpc.calls.some(call => call.method === 'sendTransaction'), false);
  assert.equal(values.has(`deployment-signature:v1:${signed.signature}`), true);
});

function failedResults(bytes = signed.transactionBase64) {
  const err = { InstructionError: [0, 'InvalidArgument'] };
  return { getSignatureStatuses: { context: { slot: 509 }, value: [{ slot: 500, confirmations: null, err, confirmationStatus: 'finalized' }] },
    getTransaction: { slot: 500, version: 0, meta: { err }, transaction: [bytes, 'base64'] } };
}
const review = (h, rpc, extra = {}) => reviewFailedDeploymentStep({ directory: h.directory, stepId, endpoint,
  fetchImpl: rpc.fetchImpl, authorizeRetryReview: true, ...extra });

test('failure review requires explicit action, exact finalized failure, unchanged accounts and unchanged journal', async t => {
  const h = await harness(t), none = upstream();
  assert.equal((await review(h, none, { authorizeRetryReview: false })).code, 'EXPLICIT_RETRY_REVIEW_REQUIRED'); assert.equal(none.calls.length, 0);
  for (const rpc of [upstream(), upstream({ override: { getTransaction: null } }),
    upstream({ completed: true, override: failedResults() })]) {
    assert.equal((await review(h, rpc)).status, 'unknown');
    assert.equal(rpc.calls.some(c => c.method === 'coolbears_authorizeFailedRetry'), false);
    assert.equal((await h.snapshot()).revision, 2);
  }
  const moved = upstream({ override: failedResults(), onCall: async call => {
    if (call.method === 'getMultipleAccounts') await appendDeploymentEvent(h.journalDirectory,
      { type: 'unknown', stepId, attempt: 1 }, { expectedRevision: 2 });
  } });
  assert.equal((await review(h, moved)).status, 'unknown');
  assert.equal(moved.calls.some(c => c.method === 'coolbears_authorizeFailedRetry'), false);
});

test('failed send to durable gateway: lost review reply, restart, explicit new signing, one replacement and finalized recovery', async t => {
  const h = await harness(t), compiled = await compileDeploymentRpcPolicy(fixture.manifest, { allowSimulation: true });
  const values = new Map(), storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); }, async transaction(fn) { return fn(this); } };
  const token = 'F'.repeat(43), env = { OPERATOR_RPC_TOKEN: token, HELIUS_API_KEY: 'test-only-secret' };
  const { DeploymentGate, worker } = makeGateway(compiled, { allowSubmission: true });
  let now = 1800000000000, rpc = upstream(), gate, loseReview = true;
  const networkCalls = [];
  function restart() {
    gate = new DeploymentGate({ storage }, env, { clock: () => now, pause: async ms => { now += ms; },
      fetchImpl: (_url, init) => { networkCalls.push(JSON.parse(init.body)); return rpc.fetchImpl(endpoint, init); } });
  }
  restart(); env.DEPLOYMENT_GATE = { idFromName: name => name, get: () => gate };
  const fetchImpl = createGatewayFetch({ endpoint, token, fetchImpl: async (url, init) => {
    const response = await worker.fetch(new Request(url, init), env);
    if (JSON.parse(init.body).method === 'coolbears_authorizeFailedRetry' && loseReview) { loseReview = false; throw Error('PRIVATE_SENTINEL'); }
    return response;
  } });
  assert.equal((await send(h, { fetchImpl })).status, 'accepted');
  rpc = upstream({ override: failedResults() });
  assert.equal((await review(h, { fetchImpl })).status, 'unknown');
  assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'accepted');
  assert.equal(values.has(`deployment-failed:v1:${signed.signature}`), true);
  restart();
  // Also lose the local journal acknowledgement path before any new signing.
  await mkdir(path.join(h.journalDirectory, '.writer-lock'), { mode: 0o700 });
  assert.equal((await review(h, { fetchImpl })).status, 'unknown');
  await rm(path.join(h.journalDirectory, '.writer-lock'), { recursive: true }); // fixture-owned lock only
  const result = await review(h, { fetchImpl }); assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.submissionAttempts, 0); assert.equal(result.gatewayRetryAuthorized, true);
  assert.equal((await review(h, { fetchImpl })).status, 'already-recorded');
  const { prepareDeploymentSigning, acceptDeploymentSigningResponse } = await import('../deployment/handoff.mjs');
  await assert.rejects(prepareDeploymentSigning({ directory: h.directory, stepId, passphrase, endpoint, fetchImpl }));
  rpc = upstream({ override: { getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('retry-hash').publicKey.toBase58(), lastValidBlockHeight: 2500 } } } });
  const prepared = await prepareDeploymentSigning({ directory: h.directory, stepId, passphrase, endpoint, fetchImpl, retry: true });
  assert.equal(prepared.request.attempt, 2); assert.notEqual(prepared.request.blockhash, request.blockhash);
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.request.transactionBase64, 'base64')); tx.sign([owner]);
  const replacement = verifySigningResponse(prepared.request, { transactionBase64: Buffer.from(tx.serialize()).toString('base64') });
  await acceptDeploymentSigningResponse({ directory: h.directory, request: prepared.request, response: { transactionBase64: replacement.transactionBase64 } });
  rpc = upstream({ override: { sendTransaction: replacement.signature } });
  const resent = await send(h, { fetchImpl }); assert.equal(resent.status, 'accepted', JSON.stringify(resent));
  rpc = upstream({ completed: true, override: {
    getTransaction: { slot: 500, version: 0, meta: { err: null }, transaction: [replacement.transactionBase64, 'base64'] } } });
  assert.equal((await resume(h, { fetchImpl })).status, 'verified');
  const snapshot = await h.snapshot(); assert.deepEqual(snapshot.steps[0].attempts.map(a => a.state), ['failed', 'verified']);
  assert.equal(snapshot.steps[0].attempts[0].signed.transactionBase64, signed.transactionBase64);
  assert.equal(networkCalls.filter(c => c.method === 'sendTransaction').length, 2);
  assert.equal(networkCalls.some(c => c.method.startsWith('coolbears_')), false);
});

test('retry-review transport grant is exact, separate from send, Devnet-only and consumed before ambiguous I/O', async () => {
  const args = { endpoint, failedRetry: { transactionBase64: signed.transactionBase64 } };
  const calls = [], fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    if (call.method === 'coolbears_authorizeFailedRetry') throw Error('lost');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: GENESIS_HASHES.devnet }));
  };
  const rpc = createDeploymentRpc({ ...args, fetchImpl });
  await assert.rejects(rpc.call('coolbears_authorizeFailedRetry', [signed.transactionBase64])); assert.equal(calls.length, 0);
  await rpc.call('getGenesisHash');
  await assert.rejects(rpc.call('coolbears_authorizeFailedRetry', [request.transactionBase64]));
  await assert.rejects(rpc.call('sendTransaction', []));
  await assert.rejects(rpc.call('coolbears_authorizeFailedRetry', [signed.transactionBase64]));
  await assert.rejects(rpc.call('coolbears_authorizeFailedRetry', [signed.transactionBase64])); assert.equal(calls.length, 2);
  const disabled = createDeploymentRpc({ endpoint, fetchImpl });
  await assert.rejects(disabled.call('coolbears_authorizeFailedRetry', [signed.transactionBase64]));
  assert.throws(() => createDeploymentRpc({ endpoint, failedRetry: { transactionBase64: request.transactionBase64 } }));
  assert.throws(() => createDeploymentRpc({ ...args, submission: { transactionBase64: signed.transactionBase64, minContextSlot: 0 } }));
  let output = '';
  assert.equal(await runDeploymentSenderCli(['review-failure', '/missing', stepId], { env: {}, write: text => { output += text; } }), 1);
  assert.match(output, /--authorize-retry/);
});
