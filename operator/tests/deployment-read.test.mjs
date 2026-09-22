// Offline integration: real Core instructions/account bytes, signatures and
// disk journals; RPC is a local Response fixture. No wallet or live call.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer, getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { createSigningRequest } from '../deployment/signing.mjs';
import { appendDeploymentEvent, createDeploymentJournal, readDeploymentJournal, nextDeploymentAction } from '../deployment/journal.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';

const seedKey = label => Keypair.fromSeed(createHash('sha256').update(`deployment-read-offline-fixture:${label}`).digest());
const owner = seedKey('owner'), collection = seedKey('collection');
const oldHash = seedKey('old-blockhash').publicKey.toBase58(), freshHash = seedKey('fresh-blockhash').publicKey.toBase58();
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
const endpoint = 'https://rpc-fixture.example/rpc?api-key=fixture-private-token';
const stepId = 'collection-create';
const encode = transaction => Buffer.from(transaction.serialize()).toString('base64');
const decode = text => VersionedTransaction.deserialize(Buffer.from(text, 'base64'));
const copy = value => JSON.parse(JSON.stringify(value));
let plan, manifest, preflightDeploymentStep, reconcileDeploymentStep, liveCalls = 0;

before(async () => {
  // This file has its own Node test worker. The approved policy file is never
  // changed; replacing only this in-memory fixture owner enables real signing.
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  ({ preflightDeploymentStep, reconcileDeploymentStep } = await import('../deployment/read.mjs'));
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
    reservedAsset: seedKey('reserve').publicKey.toBase58(), machine: seedKey('machine').publicKey.toBase58(),
    blockhash: oldHash, lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
  manifest = deploymentManifestFromPlan('read-fixture', plan);
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

function collectionAccount(changes = {}) {
  const expected = plan.steps[0].expected;
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1,
    updateAuthority: policy.owner, name: expected.name, uri: expected.uri, numMinted: 0, currentSize: 0, ...changes });
  const royalty = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{ basisPoints: 700,
    creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] });
  const pluginOffset = base.length + 9;
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1,
    pluginRegistryOffset: pluginOffset + royalty.length });
  const registry = getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1,
    registry: [{ pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset: pluginOffset }], externalRegistry: [] });
  const data = Buffer.concat([base, header, royalty, registry]);
  return { data: [data.toString('base64'), 'base64'], executable: false,
    lamports: 2000000, owner: MPL_CORE_PROGRAM_ID, rentEpoch: 0, space: data.length };
}

async function harness(t, customManifest = manifest) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-read-fixture-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'deployment');
  await createDeploymentJournal(directory, customManifest);
  const h = { directory, snapshot: () => readDeploymentJournal(directory) };
  h.append = async (type, fields = {}) => {
    const before = await h.snapshot();
    return appendDeploymentEvent(directory, { type, stepId, attempt: 1, ...fields }, { expectedRevision: before.revision });
  };
  h.prepare = async () => {
    const transaction = decode(manifest.steps[0].transactionBase64);
    transaction.message.recentBlockhash = freshHash;
    transaction.sign([collection]);
    const request = createSigningRequest({ deploymentId: manifest.id, stepId, attempt: 1,
      cluster: 'devnet', owner: policy.owner, transactionBase64: encode(transaction), lastValidBlockHeight: 2000 });
    const before = await h.snapshot();
    await appendDeploymentEvent(directory, { type: 'prepare', stepId, request, retry: false }, { expectedRevision: before.revision });
    return request;
  };
  h.advance = async (state = 'accepted') => {
    const request = await h.prepare();
    if (state === 'wallet-pending') return h.snapshot();
    const transaction = decode(request.transactionBase64); transaction.sign([owner]);
    await h.append('signed', { transactionBase64: encode(transaction) });
    if (state === 'signed') return h.snapshot();
    await h.append('claim-send');
    if (state === 'send-claimed') return h.snapshot();
    return h.append(state);
  };
  return h;
}

async function journalBytes(h) {
  const events = (await readdir(path.join(h.directory, 'events'))).sort();
  return { manifest: await readFile(path.join(h.directory, 'manifest.json'), 'utf8'),
    events: await Promise.all(events.map(async name => [name, await readFile(path.join(h.directory, 'events', name), 'utf8')])) };
}

function fixtureRpc(h, { completed = false, signed, override = {}, onCall } = {}) {
  const calls = [];
  const account = completed ? collectionAccount() : null;
  const results = {
    getGenesisHash: GENESIS_HASHES.devnet,
    getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, account, null, null, null] },
    getBalance: { context: { slot: 511 }, value: 10000000000 },
    getMinimumBalanceForRentExemption: Number(plan.machineRentLamports),
    getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: freshHash, lastValidBlockHeight: 2000 } },
    getFeeForMessage: { context: { slot: 513 }, value: 10000 },
    isBlockhashValid: { context: { slot: 514 }, value: true },
    getBlockHeight: 1500,
    getSignatureStatuses: { context: { slot: 509 }, value: [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }] },
    getTransaction: signed ? { slot: 500, version: 0, meta: { err: null }, transaction: [signed.transactionBase64, 'base64'] } : null,
    ...override,
  };
  return { calls, results,
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      calls.push({ url, ...request, options });
      await onCall?.(request, results);
      assert.ok(Object.hasOwn(results, request.method), `Unexpected RPC method ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  };
}
const preflight = (h, rpc) => preflightDeploymentStep({ directory: h.directory, stepId, endpoint, fetchImpl: rpc.fetchImpl });
const reconcile = (h, rpc) => reconcileDeploymentStep({ directory: h.directory, stepId, endpoint, fetchImpl: rpc.fetchImpl });
function readOnly(result) {
  assert.equal(result.transactionsSent, 0); assert.equal(result.journalWrites, 0);
  assert.equal(result.readyToSubmit, false); assert.equal(result.salesOpen, false);
  assert.equal(JSON.stringify(result).includes('fixture-private-token'), false);
}

test('fresh preflight quotes the refreshed unsigned message and leaves the full canonical journal unchanged', async t => {
  const h = await harness(t), before = await journalBytes(h), rpc = fixtureRpc(h);
  const result = await preflight(h, rpc);
  assert.equal(result.status, 'read-checks-passed'); readOnly(result);
  assert.equal(result.source, 'refreshed-unsigned-template');
  assert.equal(result.candidate.blockhash, freshHash); assert.notEqual(result.candidate.messageSha256, manifest.steps[0].messageSha256);
  const candidate = decode(result.candidate.transactionBase64);
  assert.ok(candidate.signatures.every(signature => signature.every(byte => byte === 0)));
  const quote = rpc.calls.find(call => call.method === 'getFeeForMessage');
  assert.equal(quote.params[0], Buffer.from(candidate.message.serialize()).toString('base64'));
  assert.notEqual(quote.params[0], Buffer.from(decode(manifest.steps[0].transactionBase64).message.serialize()).toString('base64'));
  assert.deepEqual(quote.params[1], { commitment: 'confirmed', minContextSlot: 512 });
  assert.deepEqual(rpc.calls.map(call => call.method), ['getGenesisHash', 'getMultipleAccounts', 'getBalance',
    'getMinimumBalanceForRentExemption', 'getLatestBlockhash', 'getFeeForMessage', 'isBlockhashValid', 'getBlockHeight']);
  assert.equal(result.budget.complete, false); assert.equal(result.budget.totalDeploymentLamports, null);
  assert.equal(result.budget.stepNetworkFeeLamports, '10000'); assert.equal(result.lifetimeGuaranteed, false);
  assert.equal(result.expectedRevision, 0); assert.equal(result.expectedHeadHash, (await h.snapshot()).headHash);
  for (const call of rpc.calls) {
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit');
  }
  assert.deepEqual(await journalBytes(h), before);
});

test('preflight of wallet-pending or signed attempts preserves every already saved signature', async t => {
  for (const state of ['wallet-pending', 'signed']) {
    const h = await harness(t); const snapshot = await h.advance(state); const before = await journalBytes(h);
    const rpc = fixtureRpc(h); const result = await preflight(h, rpc); const attempt = snapshot.steps[0].attempts[0]; const request = attempt.request;
    assert.equal(result.status, 'read-checks-passed'); readOnly(result);
    assert.equal(result.source, 'saved-attempt'); assert.equal(result.candidate.transactionBase64, attempt.signed?.transactionBase64 ?? request.transactionBase64);
    assert.equal(decode(result.candidate.transactionBase64).signatures[0].some(Boolean), state === 'signed');
    assert.equal(result.candidate.messageSha256, request.messageSha256); assert.equal(result.candidate.lastValidBlockHeight, request.lastValidBlockHeight);
    assert.equal(rpc.calls.some(call => call.method === 'getLatestBlockhash'), false);
    assert.equal(rpc.calls.find(call => call.method === 'getFeeForMessage').params[0], Buffer.from(decode(request.transactionBase64).message.serialize()).toString('base64'));
    assert.deepEqual(await journalBytes(h), before);
  }
});

test('null fee, insufficient known-cost balance and changed machine rent block preflight without writes', async t => {
  const h = await harness(t), before = await journalBytes(h);
  for (const [override, code] of [
    [{ getFeeForMessage: { context: { slot: 513 }, value: null } }, 'FEE_QUOTE_UNAVAILABLE'],
    [{ getBalance: { context: { slot: 511 }, value: 9999 } }, 'BALANCE_BELOW_KNOWN_COSTS'],
    [{ getMinimumBalanceForRentExemption: Number(plan.machineRentLamports) + 1 }, 'MACHINE_RENT_CHANGED_REBUILD_PLAN'],
  ]) {
    const result = await preflight(h, fixtureRpc(h, { override }));
    assert.equal(result.status, 'blocked'); assert.equal(result.code, code); readOnly(result);
  }
  assert.deepEqual(await journalBytes(h), before);
});

test('wrong network, an existing new account or stale context cannot pass read checks', async t => {
  const h = await harness(t), before = await journalBytes(h);
  const cases = [
    { getGenesisHash: GENESIS_HASHES['mainnet-beta'] },
    { getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, collectionAccount(), null, null, null] } },
    { getBalance: { context: { slot: 509 }, value: 10000000000 } },
    { getFeeForMessage: { context: { slot: 511 }, value: 10000 } },
  ];
  for (const override of cases) {
    const result = await preflight(h, fixtureRpc(h, { override }));
    assert.equal(result.status, 'blocked'); readOnly(result);
  }
  assert.deepEqual(await journalBytes(h), before);
});

test('unusable blockhash and noncanonical intent fail closed, without refreshing an active attempt', async t => {
  const h = await harness(t); await h.advance('wallet-pending'); const before = await journalBytes(h);
  for (const override of [{ isBlockhashValid: { context: { slot: 514 }, value: false } }, { getBlockHeight: 2000 }]) {
    const rpc = fixtureRpc(h, { override }); const result = await preflight(h, rpc);
    assert.equal(result.status, 'blocked'); readOnly(result); assert.equal(rpc.calls.some(call => call.method === 'getLatestBlockhash'), false);
  }
  assert.deepEqual(await journalBytes(h), before);
  const changed = copy(manifest); changed.steps[0].expected.name = 'Unauthorized collection name';
  const invalid = await harness(t, changed), rpc = fixtureRpc(invalid);
  assert.equal((await preflight(invalid, rpc)).status, 'blocked'); assert.equal(rpc.calls.length, 0);
});

test('accepted attempts require reconciliation; missing finalized receipt stays unknown without journal writes', async t => {
  const h = await harness(t), snapshot = await h.advance(), before = await journalBytes(h);
  const signed = snapshot.steps[0].attempts[0].signed;
  const noPreflight = fixtureRpc(h); const blocked = await preflight(h, noPreflight);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.code, 'RECONCILIATION_REQUIRED'); assert.equal(noPreflight.calls.length, 0);
  for (const override of [{ getTransaction: null }, { getSignatureStatuses: { context: { slot: 509 }, value: [null] } },
    { getTransaction: { slot: 500, version: 0, meta: null, transaction: [signed.transactionBase64, 'base64'] } }]) {
    const rpc = fixtureRpc(h, { completed: true, signed, override }); const result = await reconcile(h, rpc);
    assert.equal(result.status, 'unknown'); readOnly(result); assert.equal('proof' in result, false);
    assert.equal(rpc.calls.some(call => call.method === 'getMultipleAccounts'), false);
  }
  assert.deepEqual(await journalBytes(h), before); assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'accepted');
});

test('real finalized receipt plus Core collection bytes yields a scoped proof for a separate CAS journal append', async t => {
  const h = await harness(t), snapshot = await h.advance(), before = await journalBytes(h);
  const signed = snapshot.steps[0].attempts[0].signed;
  const rpc = fixtureRpc(h, { completed: true, signed }); const result = await reconcile(h, rpc);
  assert.equal(result.status, 'verified'); readOnly(result); assert.deepEqual(await journalBytes(h), before);
  assert.deepEqual(rpc.calls.map(call => call.method), ['getGenesisHash', 'getSignatureStatuses', 'getTransaction', 'getMultipleAccounts']);
  assert.deepEqual(rpc.calls[1].params, [[signed.signature], { searchTransactionHistory: true }]);
  assert.deepEqual(rpc.calls[2].params, [signed.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  assert.equal(rpc.calls[3].params[1].minContextSlot, 500); assert.equal(rpc.calls[3].params[1].commitment, 'finalized');
  assert.equal(result.proof.signature, signed.signature); assert.equal(result.proof.messageSha256, signed.messageSha256);
  assert.equal(result.proof.expectedStateVerified, true); assert.equal(result.proof.readSlot, 510);
  assert.equal(result.expectedRevision, snapshot.revision); assert.equal(result.expectedHeadHash, snapshot.headHash);
  const saved = await appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1, proof: result.proof }, { expectedRevision: result.expectedRevision });
  assert.equal(saved.steps[0].attempts[0].state, 'verified'); assert.equal(saved.revision, snapshot.revision + 1);
  assert.deepEqual(nextDeploymentAction(saved), { type: 'prepare', stepId: 'reserve-create' });
});

test('a valid receipt cannot replace checking collection authority or the finalized account bank', async t => {
  const h = await harness(t), snapshot = await h.advance(), before = await journalBytes(h);
  const signed = snapshot.steps[0].attempts[0].signed;
  for (const [slot, account] of [[499, collectionAccount()], [510, collectionAccount({ updateAuthority: collection.publicKey.toBase58() })], [510, null]]) {
    const rpc = fixtureRpc(h, { signed, completed: true, override: { getMultipleAccounts: { context: { slot },
      value: [{ executable: true }, { executable: true }, { executable: true }, account, null, null, null] } } });
    const result = await reconcile(h, rpc); assert.equal(result.status, 'unknown'); readOnly(result); assert.equal('proof' in result, false);
  }
  assert.deepEqual(await journalBytes(h), before);
});

test('a concurrent journal event invalidates the preflight snapshot before candidate release', async t => {
  const h = await harness(t);
  const rpc = fixtureRpc(h, { onCall: async request => { if (request.method === 'getBlockHeight') await h.prepare(); } });
  const result = await preflight(h, rpc);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'JOURNAL_CHANGED_DURING_READ'); readOnly(result);
  assert.equal('candidate' in result, false); const current = await h.snapshot();
  assert.equal(current.revision, 1); assert.equal(current.steps[0].attempts[0].state, 'wallet-pending');
});

test('a concurrent journal change during receipt reads leaves the new unknown state intact', async t => {
  const h = await harness(t), snapshot = await h.advance();
  const rpc = fixtureRpc(h, { signed: snapshot.steps[0].attempts[0].signed, completed: true,
    onCall: async request => { if (request.method === 'getMultipleAccounts') await h.append('unknown'); } });
  const result = await reconcile(h, rpc);
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'JOURNAL_CHANGED_DURING_READ'); readOnly(result);
  assert.equal('proof' in result, false); const current = await h.snapshot();
  assert.equal(current.revision, snapshot.revision + 1); assert.equal(current.steps[0].attempts[0].state, 'unknown');
});

test('CAS rejects a proof append if the journal changes after successful read reconciliation', async t => {
  const h = await harness(t), snapshot = await h.advance();
  const result = await reconcile(h, fixtureRpc(h, { signed: snapshot.steps[0].attempts[0].signed, completed: true }));
  assert.equal(result.status, 'verified'); await h.append('unknown'); const before = await journalBytes(h);
  await assert.rejects(appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1, proof: result.proof },
    { expectedRevision: result.expectedRevision }), /STALE_REVISION/);
  assert.deepEqual(await journalBytes(h), before); assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'unknown');
});
