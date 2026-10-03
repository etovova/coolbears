// Disposable TEST keys, SDK account encodings and fixture RPC receipts only.
// No live network, wallet, production custody or blockchain submission.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { none, some } from '@metaplex-foundation/umi';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer,
  getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer as collectionSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer as registrySerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { getAssetV1AccountDataSerializer as assetSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { createSigningRequest } from '../deployment/signing.mjs';
import { appendDeploymentEvent, createDeploymentJournal, readDeploymentJournal,
  nextDeploymentAction } from '../deployment/journal.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { fixtureRpcAccount, hiddenAccountFixtures } from './fixtures/hidden-accounts.mjs';

const key = label => Keypair.fromSeed(createHash('sha256').update(`hidden-machine-recovery-TEST:${label}`).digest());
const owner = key('owner'), collection = key('collection'), reserve = key('reserve'), machine = key('machine');
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
const endpoint = 'https://hidden-recovery-fixture.example/rpc?api-key=TEST_PRIVATE_SENTINEL';
const oldHash = key('oldhash').publicKey.toBase58(), freshHash = key('freshhash').publicKey.toBase58();
const commitment = createHash('sha256').update('TEST final mapping, never production').digest('hex');
const storageOptions = { storageMode: 'hidden-settings', hiddenCommitmentSha256: commitment };
const stepId = 'machine-create', encode = tx => Buffer.from(tx.serialize()).toString('base64');
const decode = value => VersionedTransaction.deserialize(Buffer.from(value, 'base64'));
const programAccounts = () => [{ executable: true }, { executable: true }, { executable: true }];
let manifest, plan, accounts, reconcileDeploymentStep, reconcileFailedDeploymentStep,
  reconcileExpiredDeploymentStep, liveCalls = 0;

before(async () => {
  // Import after replacing only this isolated Node worker's in-memory policy.
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  ({ reconcileDeploymentStep, reconcileFailedDeploymentStep, reconcileExpiredDeploymentStep } = await import('../deployment/read.mjs'));
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
    reservedAsset: reserve.publicKey.toBase58(), machine: machine.publicKey.toBase58(), blockhash: oldHash,
    lastValidBlockHeight: 1000, machineRentLamports: '3962400', ...storageOptions });
  manifest = deploymentManifestFromPlan('hidden-machine-recovery-TEST', plan);
  accounts = hiddenAccountFixtures({ policy, storageOptions, roles: plan.roles });
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

function predecessorCollection(minted) {
  const expected = plan.steps[0].expected;
  const base = collectionSerializer().serialize({ key: Key.CollectionV1, updateAuthority: policy.owner,
    name: expected.name, uri: expected.uri, numMinted: minted, currentSize: minted });
  const royalty = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{ basisPoints: 700,
    creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] });
  const offset = base.length + 9;
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1,
    pluginRegistryOffset: offset + royalty.length });
  const registry = registrySerializer().serialize({ key: Key.PluginRegistryV1, registry: [
    { pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset }], externalRegistry: [] });
  return fixtureRpcAccount(Buffer.concat([base, header, royalty, registry]), MPL_CORE_PROGRAM_ID);
}
function reserveAccount() {
  const expected = plan.steps[1].expected;
  return fixtureRpcAccount(assetSerializer().serialize({ key: Key.AssetV1, owner: policy.owner,
    updateAuthority: { __kind: 'Collection', fields: [plan.roles.collection] },
    name: expected.name, uri: expected.uri, seq: none() }), MPL_CORE_PROGRAM_ID);
}
function accountBank(completedIndex) {
  return [...programAccounts(), completedIndex >= 2 ? accounts.collectionAccount(0)
    : completedIndex >= 0 ? predecessorCollection(completedIndex >= 1 ? 1 : 0) : null,
  completedIndex >= 1 ? reserveAccount() : null,
  completedIndex >= 2 ? accounts.machineAccount() : null, completedIndex >= 2 ? accounts.guardAccount() : null];
}

async function journalBytes(directory) {
  const filenames = (await readdir(path.join(directory, 'events'))).sort();
  return { manifest: await readFile(path.join(directory, 'manifest.json')),
    events: await Promise.all(filenames.map(async filename => [filename, await readFile(path.join(directory, 'events', filename))])) };
}
function readOnly(result) {
  assert.equal(result.readyToSubmit, false); assert.equal(result.salesOpen, false);
  assert.equal(result.transactionsSent, 0); assert.equal(result.journalWrites, 0);
  assert.ok(!JSON.stringify(result).includes('TEST_PRIVATE_SENTINEL'));
}
function fixtureRpc({ signed, completedIndex = 2, error = null, override = {}, onCall } = {}) {
  const calls = [], results = {
    getGenesisHash: GENESIS_HASHES.devnet,
    getSignatureStatuses: { context: { slot: 810 }, value: [{ slot: 500, confirmations: null,
      confirmationStatus: 'finalized', err: error }] },
    getTransaction: { slot: 500, version: 0, meta: { err: error }, transaction: [signed.transactionBase64, 'base64'] },
    getMultipleAccounts: { context: { slot: 820 }, value: accountBank(completedIndex) },
    isBlockhashValid: { context: { slot: 800 }, value: false }, getBlockHeight: 2001,
    ...override,
  };
  return { calls, results, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const request = JSON.parse(init.body); calls.push(request);
    assert.ok(Object.hasOwn(results, request.method), `Unexpected RPC method ${request.method}`);
    await onCall?.(request, results);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  } };
}
async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-hidden-recovery-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'journal'); await createDeploymentJournal(directory, manifest);
  const h = { directory, snapshot: () => readDeploymentJournal(directory) };
  h.append = async (type, fields = {}, id = stepId) => {
    const snapshot = await h.snapshot();
    return appendDeploymentEvent(directory, { type, stepId: id, attempt: 1, ...fields }, { expectedRevision: snapshot.revision });
  };
  h.accept = async index => {
    const step = manifest.steps[index], transaction = decode(step.transactionBase64);
    transaction.message.recentBlockhash = freshHash; transaction.sign([[collection, reserve, machine][index]]);
    const request = createSigningRequest({ deploymentId: manifest.id, stepId: step.id, attempt: 1, cluster: 'devnet',
      owner: policy.owner, transactionBase64: encode(transaction), lastValidBlockHeight: 2000 });
    const snapshot = await h.snapshot();
    await appendDeploymentEvent(directory, { type: 'prepare', stepId: step.id, request, retry: false }, { expectedRevision: snapshot.revision });
    transaction.sign([owner]); await h.append('signed', { transactionBase64: encode(transaction) }, step.id);
    await h.append('claim-send', {}, step.id); await h.append('accepted', {}, step.id);
    return (await h.snapshot()).steps[index].attempts[0].signed;
  };
  // Every dependency proof comes from the real read adapter with complete
  // SDK account bytes, rather than assigning already-verified journal states.
  for (const index of [0, 1]) {
    const signed = await h.accept(index), rpc = fixtureRpc({ signed, completedIndex: index });
    const result = await reconcileDeploymentStep({ directory, stepId: manifest.steps[index].id,
      endpoint, fetchImpl: rpc.fetchImpl, trustedHiddenCommitmentSha256: commitment });
    assert.equal(result.status, 'verified', JSON.stringify(result)); readOnly(result);
    await appendDeploymentEvent(directory, { type: 'reconcile', stepId: manifest.steps[index].id,
      attempt: 1, proof: result.proof }, { expectedRevision: result.expectedRevision });
  }
  h.signed = await h.accept(2);
  return h;
}
const reconcile = (h, rpc, extra = {}) => reconcileDeploymentStep({ directory: h.directory, stepId,
  endpoint, fetchImpl: rpc.fetchImpl, trustedHiddenCommitmentSha256: commitment, ...extra });
const reconcileFailure = (h, rpc) => reconcileFailedDeploymentStep({ directory: h.directory, stepId,
  endpoint, fetchImpl: rpc.fetchImpl, trustedHiddenCommitmentSha256: commitment });
const expiryEvidence = () => ({ blockhash: freshHash, anchorSlot: 400, slot: 800, blockHeight: 2001,
  lastValidBlockHeight: 2000, historyPages: 1, historySha256: 'e'.repeat(64) });
const reconcileExpiry = (h, rpc, evidence = expiryEvidence()) => reconcileExpiredDeploymentStep({ directory: h.directory,
  stepId, endpoint, fetchImpl: rpc.fetchImpl, evidence, trustedHiddenCommitmentSha256: commitment });

test('exact finalized hidden machine receipt and complete account bank finish all three dependency steps via explicit CAS', async t => {
  const h = await harness(t), before = await journalBytes(h.directory), rpc = fixtureRpc({ signed: h.signed });
  const result = await reconcile(h, rpc);
  assert.equal(result.status, 'verified'); readOnly(result); assert.deepEqual(await journalBytes(h.directory), before);
  assert.deepEqual(rpc.calls.map(call => call.method), ['getGenesisHash', 'getSignatureStatuses', 'getTransaction', 'getMultipleAccounts']);
  assert.equal(rpc.calls[3].params[1].minContextSlot, 500);
  assert.equal(result.proof.signature, h.signed.signature); assert.equal(result.proof.expectedStateVerified, true);
  const saved = await appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1,
    proof: result.proof }, { expectedRevision: result.expectedRevision });
  assert.equal(saved.steps.length, 3); assert.ok(saved.steps.every(step => step.attempts.at(-1).state === 'verified'));
  assert.deepEqual(nextDeploymentAction(saved), { type: 'complete', readyToOpenSales: false });
  const replayed = await readDeploymentJournal(h.directory); assert.deepEqual(replayed, saved);
});

test('a valid hidden receipt cannot conceal altered commitment, price, machine layout, redemption or missing account', async t => {
  const h = await harness(t), before = await journalBytes(h.directory);
  const alteredHash = some({ ...accounts.profile.hiddenSettings, hash: new Uint8Array(32).fill(17) });
  const cases = [bank => { bank[5] = accounts.machineAccount(0, { hiddenSettings: alteredHash }); },
    bank => { bank[6] = accounts.guardAccount(200000001n); },
    bank => { bank[5] = accounts.machineAccount(0, {}, 1); },
    bank => { bank[5] = accounts.machineAccount(1); bank[3] = accounts.collectionAccount(1); },
    bank => { bank[5] = null; }, bank => { bank[6] = null; },
    bank => { bank[3] = predecessorCollection(1); }];
  for (const change of cases) {
    const bank = accountBank(2); change(bank);
    const rpc = fixtureRpc({ signed: h.signed, override: { getMultipleAccounts: { context: { slot: 820 }, value: bank } } });
    const result = await reconcile(h, rpc); assert.equal(result.status, 'unknown'); readOnly(result);
    assert.equal(result.code, 'EXPECTED_ACCOUNT_STATE_MISMATCH'); assert.equal('proof' in result, false);
  }
  assert.deepEqual(await journalBytes(h.directory), before);
  const trustedMismatch = fixtureRpc({ signed: h.signed });
  const invalid = await reconcile(h, trustedMismatch, { trustedHiddenCommitmentSha256: 'a'.repeat(64) });
  assert.equal(invalid.code, 'DEPLOYMENT_INTENT_INVALID'); assert.equal(trustedMismatch.calls.length, 0);
});

test('missing, nonfinalized, mismatched-byte or stale-bank receipts retain the accepted hidden attempt', async t => {
  const h = await harness(t), before = await journalBytes(h.directory);
  const otherTransaction = decode(h.signed.transactionBase64); otherTransaction.message.recentBlockhash = oldHash;
  otherTransaction.sign([owner, machine]);
  for (const override of [{ getTransaction: null },
    { getSignatureStatuses: { context: { slot: 810 }, value: [null] } },
    { getSignatureStatuses: { context: { slot: 810 }, value: [{ slot: 500, confirmations: 1, confirmationStatus: 'confirmed', err: null }] } },
    { getTransaction: { slot: 500, version: 0, meta: { err: null }, transaction: [encode(otherTransaction), 'base64'] } },
    { getMultipleAccounts: { context: { slot: 499 }, value: accountBank(2) } }]) {
    const result = await reconcile(h, fixtureRpc({ signed: h.signed, override }));
    assert.equal(result.status, 'unknown'); readOnly(result); assert.equal('proof' in result, false);
  }
  assert.deepEqual(await journalBytes(h.directory), before);
  assert.equal((await h.snapshot()).steps[2].attempts[0].state, 'accepted');
});

test('finalized hidden machine failure requires exact rollback state and preserves every previous account', async t => {
  const h = await harness(t), before = await journalBytes(h.directory), error = { InstructionError: [1, { Custom: 123 }] };
  const rpc = fixtureRpc({ signed: h.signed, completedIndex: 1, error });
  const result = await reconcileFailure(h, rpc);
  assert.equal(result.status, 'failed-verified'); readOnly(result); assert.equal(result.proof.effectsAbsent, true);
  assert.deepEqual(await journalBytes(h.directory), before);
  for (const change of [bank => { bank[5] = accounts.machineAccount(); }, bank => { bank[6] = accounts.guardAccount(); },
    bank => { bank[3] = accounts.collectionAccount(0); }, bank => { bank[4] = null; }]) {
    const bank = accountBank(1); change(bank);
    const failed = await reconcileFailure(h, fixtureRpc({ signed: h.signed, error,
      override: { getMultipleAccounts: { context: { slot: 820 }, value: bank } } }));
    assert.equal(failed.status, 'unknown'); assert.equal('proof' in failed, false); readOnly(failed);
  }
  const contradiction = await reconcileFailure(h, fixtureRpc({ signed: h.signed, completedIndex: 1, error,
    override: { getTransaction: { slot: 500, version: 0, meta: { err: 'DifferentFailure' }, transaction: [h.signed.transactionBase64, 'base64'] } } }));
  assert.equal(contradiction.status, 'unknown'); assert.equal(contradiction.code, 'DEPLOYMENT_RECEIPT_INVALID');
  assert.deepEqual(await journalBytes(h.directory), before);
  const saved = await appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1,
    proof: result.proof }, { expectedRevision: result.expectedRevision });
  assert.deepEqual(nextDeploymentAction(saved), { type: 'retry-review', stepId });
  assert.ok(saved.steps.slice(0, 2).every(step => step.attempts[0].state === 'verified'));
});

test('expired hidden machine attempt requires bound evidence, finalized absence and exact predecessor state', async t => {
  const h = await harness(t), before = await journalBytes(h.directory);
  const overrides = { getSignatureStatuses: { context: { slot: 810 }, value: [null] }, getTransaction: null };
  const rpc = fixtureRpc({ signed: h.signed, completedIndex: 1, override: overrides });
  const result = await reconcileExpiry(h, rpc);
  assert.equal(result.status, 'expired-verified'); readOnly(result); assert.equal(result.proof.effectsAbsent, true);
  assert.deepEqual(rpc.calls.map(call => call.method), ['getGenesisHash', 'isBlockhashValid', 'getBlockHeight',
    'getSignatureStatuses', 'getTransaction', 'getMultipleAccounts']);
  for (const override of [{ ...overrides, isBlockhashValid: { context: { slot: 800 }, value: true } },
    { ...overrides, getBlockHeight: 2000 },
    { getTransaction: null },
    { ...overrides, getMultipleAccounts: { context: { slot: 799 }, value: accountBank(1) } },
    { ...overrides, getMultipleAccounts: { context: { slot: 820 }, value: accountBank(2) } }]) {
    const failed = await reconcileExpiry(h, fixtureRpc({ signed: h.signed, completedIndex: 1, override }));
    assert.equal(failed.status, 'unknown'); assert.equal('proof' in failed, false); readOnly(failed);
  }
  const mismatchRpc = fixtureRpc({ signed: h.signed, completedIndex: 1, override: overrides });
  const mismatched = await reconcileExpiry(h, mismatchRpc, { ...expiryEvidence(), blockhash: oldHash });
  assert.equal(mismatched.code, 'EXPIRY_EVIDENCE_MISMATCH'); assert.equal(mismatchRpc.calls.length, 0);
  assert.deepEqual(await journalBytes(h.directory), before);
  const saved = await appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1,
    proof: result.proof }, { expectedRevision: result.expectedRevision });
  assert.deepEqual(nextDeploymentAction(saved), { type: 'retry-review', stepId });
});

test('concurrent hidden reconciliation invalidates a scoped proof and cannot overwrite the later journal state', async t => {
  const h = await harness(t);
  const concurrent = fixtureRpc({ signed: h.signed, onCall: async request => {
    if (request.method === 'getMultipleAccounts') await h.append('unknown');
  } });
  const rejected = await reconcile(h, concurrent);
  assert.equal(rejected.status, 'unknown'); assert.equal(rejected.code, 'JOURNAL_CHANGED_DURING_READ');
  assert.equal('proof' in rejected, false); readOnly(rejected);
  const result = await reconcile(h, fixtureRpc({ signed: h.signed }));
  assert.equal(result.status, 'verified'); await h.append('unknown');
  const before = await journalBytes(h.directory);
  await assert.rejects(appendDeploymentEvent(h.directory, { type: 'reconcile', stepId, attempt: 1,
    proof: result.proof }, { expectedRevision: result.expectedRevision }), /STALE_REVISION/);
  assert.deepEqual(await journalBytes(h.directory), before);
  assert.equal((await h.snapshot()).steps[2].attempts[0].state, 'unknown');
});
