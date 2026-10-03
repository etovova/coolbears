// Canonical SDK bytes and private ephemeral custody, with synthetic RPC only.
// The commitment below is a TEST fixture, not the collection's final mapping.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction, VersionedMessage } from '@solana/web3.js';
import { none } from '@metaplex-foundation/umi';
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { policy } from '../prepare.mjs';
import { quoteMachine } from '../cost.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { buildDeploymentCostModel } from '../deployment/cost-model.mjs';
import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { createRequestValidator } from '../deployment/request-policy.mjs';
import { createScopedDeploymentRpc } from '../deployment/scoped-rpc.mjs';
import { quoteDeploymentBudget } from '../deployment/budget.mjs';
import { preflightDeploymentStep, checkDeploymentState } from '../deployment/read.mjs';
import { simulateDeploymentStep } from '../deployment/simulation.mjs';
import { createDeploymentJournal, readDeploymentJournal } from '../deployment/journal.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle, readDeploymentBundle } from '../deployment/vault-store.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { previewDevnetDeployment } from '../deployment/preview.mjs';
import { previewIsolatedDeployment } from '../deployment/isolated-preview.mjs';
import { hiddenAccountFixtures, fixtureRpcAccount } from './fixtures/hidden-accounts.mjs';

const key = n => Keypair.fromSeed(createHash('sha256').update(`hidden-compatibility-TEST:${n}`).digest());
const address = n => key(n).publicKey.toBase58();
const commitment = createHash('sha256').update('TEST final mapping, never production').digest('hex');
const endpoint = 'https://hidden-rpc-fixture.example/';
const rent = bytes => 3000 + bytes * 11; // Deliberately not Solana's rent schedule.
const input = { cluster: 'devnet', collection: address('collection'), reservedAsset: address('reserve'),
  machine: address('machine'), blockhash: address('oldhash'), lastValidBlockHeight: 1000,
  machineRentLamports: String(rent(652)), storageMode: 'hidden-settings', hiddenCommitmentSha256: commitment };
let plan, manifest, model, compiled, originalFetch, liveCalls = 0;

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  plan = await buildDeploymentPlan(input); manifest = deploymentManifestFromPlan('hidden-compatibility-TEST', plan);
  ({ model } = await buildDeploymentCostModel(manifest, { trustedHiddenCommitmentSha256: commitment }));
  compiled = await compileDeploymentRpcPolicy(manifest, { allowSimulation: true, trustedHiddenCommitmentSha256: commitment });
});
after(() => { globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

async function journal(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-hidden-compat-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'journal'); await createDeploymentJournal(directory, manifest);
  return directory;
}
function fixture(overrides = {}) {
  const calls = [], fees = [];
  return { calls, fees, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const request = JSON.parse(init.body); calls.push(request);
    const slot = 500 + calls.length;
    let result;
    switch (request.method) {
      case 'getGenesisHash': result = GENESIS_HASHES.devnet; break;
      case 'getMultipleAccounts': result = { context: { slot }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] }; break;
      case 'getMinimumBalanceForRentExemption': result = rent(request.params[0]); break;
      case 'getLatestBlockhash': result = { context: { slot }, value: { blockhash: address('freshhash'), lastValidBlockHeight: 2000 } }; break;
      case 'getFeeForMessage': {
        const message = VersionedMessage.deserialize(Buffer.from(request.params[0], 'base64'));
        const fee = message.header.numRequiredSignatures * 5000;
        fees.push(fee); result = { context: { slot }, value: fee }; break;
      }
      case 'getBalance': result = { context: { slot }, value: 10000000000 }; break;
      case 'isBlockhashValid': result = { context: { slot }, value: true }; break;
      case 'getBlockHeight': result = 1500; break;
      case 'simulateTransaction': result = { context: { slot }, value: { err: null, unitsConsumed: 4242, logs: ['DO_NOT_ECHO_TEST_SENTINEL'] } }; break;
      default: assert.fail(`Unexpected network method ${request.method}`);
    }
    if (Object.hasOwn(overrides, request.method)) result = overrides[request.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } };
}
function safe(result) {
  assert.equal(result.readyToSubmit, false); assert.equal(result.salesOpen, false);
  assert.equal(result.transactionsSent, 0); assert.equal(result.journalWrites, 0);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO_TEST_SENTINEL'));
}

test('hidden cost model quotes SDK account sizes, all six required signatures and no insert fees', () => {
  assert.equal(plan.steps.length, 3); assert.equal(model.steps.length, 3); assert.equal(model.requiredSignatures, 6);
  assert.equal(model.sizes.machine, 652); assert.equal(model.storageMode, 'hidden-settings');
  assert.equal(model.hiddenCommitmentSha256, commitment); assert.equal(model.privateMappingVerified, false);
  assert.equal(model.buyerMintsIncluded, 0); assert.equal(model.salesOpen, false);
  assert.equal(model.protocolItems.length, 1); assert.equal(model.protocolItems[0].lamports, '1500000');
});

test('standalone machine rent quote selects 652-byte hidden layout and rejects incomplete mode before network', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const results = { getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 500 }, value: [{ executable: true }, { executable: true }, { executable: true }] },
      getBalance: { context: { slot: 501 }, value: 10000000000 },
      getLatestBlockhash: { context: { slot: 502 }, value: { blockhash: address('freshhash'), lastValidBlockHeight: 2000 } },
      getMinimumBalanceForRentExemption: rent(652) };
    assert.ok(Object.hasOwn(results, request.method));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  };
  const result = await quoteMachine(endpoint, { storageMode: input.storageMode, hiddenCommitmentSha256: commitment, fetchImpl });
  assert.equal(result.accountBytes, 652); assert.equal(result.machineRentLamports, rent(652));
  assert.equal(result.storageMode, 'hidden-settings'); assert.equal(result.privateMappingVerified, false);
  assert.equal(result.totalReleaseCostQuoted, false); assert.equal(result.transactionsSent, 0);
  assert.deepEqual(calls.at(-1).params, [652, { commitment: 'finalized' }]);
  calls.length = 0;
  await assert.rejects(quoteMachine(endpoint, { storageMode: input.storageMode, fetchImpl }), /INVALID_HIDDEN_COMMITMENT_SHA256/);
  assert.equal(calls.length, 0);
});

test('public and isolated previews refuse incomplete hidden profile before spending RPC requests', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; assert.fail('No RPC for an invalid storage profile'); };
  const publicPreview = await previewDevnetDeployment({ endpoint, fetchImpl, storageMode: 'hidden-settings' });
  const isolated = await previewIsolatedDeployment({ endpoint, fetchImpl, storageMode: 'hidden-settings' });
  for (const result of [publicPreview, isolated.report]) {
    assert.equal(result.status, 'blocked'); assert.equal(result.transactionsSent, 0);
    assert.equal(result.readyToSubmit, false); assert.equal(result.salesOpen, false);
  }
  assert.equal(calls, 0);
});

test('hidden RPC profile is explicitly versioned; legacy policy count and shape remain unchanged', async () => {
  assert.equal(compiled.version, 2); assert.equal(compiled.storageMode, 'hidden-settings');
  assert.equal(compiled.hiddenCommitmentSha256, commitment); assert.equal(compiled.messageIdentities.length, 3);
  assert.ok(compiled.sizes.includes(652)); assert.ok(!compiled.sizes.includes(871827));
  const legacy = await buildDeploymentPlan({ ...input, storageMode: undefined, hiddenCommitmentSha256: undefined,
    machineRentLamports: String(rent(871827)) });
  const oldPolicy = await compileDeploymentRpcPolicy(deploymentManifestFromPlan('legacy-preserved-TEST', legacy));
  assert.equal(oldPolicy.version, 1); assert.equal(oldPolicy.messageIdentities.length, 1431);
  assert.ok(!Object.hasOwn(oldPolicy, 'storageMode')); assert.ok(!Object.hasOwn(oldPolicy, 'hiddenCommitmentSha256'));
  for (const mutate of [p => { p.version = 1; }, p => { delete p.storageMode; },
    p => { p.storageMode = 'config-lines'; }, p => { p.messageIdentities.pop(); },
    p => { p.messageIdentities[1] = p.messageIdentities[0]; }, p => { p.hiddenCommitmentSha256 = 'x'; },
    p => { p.sizes.push(871827); }, p => { p.unapproved = true; }]) {
    const changed = structuredClone(compiled); mutate(changed);
    assert.throws(() => createRequestValidator(changed), { code: 'CONFIGURATION' });
  }
});

test('all three exact hidden fee messages accept a refreshed blockhash; altered bytes and sends fail before network', async () => {
  const f = fixture(); const rpc = await createScopedDeploymentRpc({ manifest, endpoint, fetchImpl: f.fetchImpl });
  for (const step of plan.steps) {
    const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
    tx.message.recentBlockhash = address('freshhash');
    const params = [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'confirmed' }];
    assert.equal((await rpc.call('getFeeForMessage', params)).value, 10000);
    tx.message.compiledInstructions[0].data[0] ^= 1;
    await assert.rejects(rpc.call('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), params[1]]), { code: 'PARAMS' });
  }
  await assert.rejects(rpc.call('sendTransaction', []), { code: 'METHOD' });
  assert.equal(f.calls.length, 4); assert.equal(f.calls[0].method, 'getGenesisHash');
});

test('full budget uses three exact fees and preserves the immutable journal without claiming a production quote', async t => {
  const directory = await journal(t), before = await readDeploymentJournal(directory), f = fixture();
  const result = await quoteDeploymentBudget({ directory, endpoint, fetchImpl: f.fetchImpl,
    bufferBasisPoints: 0, retryTransactions: 0, trustedHiddenCommitmentSha256: commitment });
  safe(result); assert.equal(result.status, 'budget-estimated'); assert.equal(f.fees.length, 3);
  const accountRent = rent(model.sizes.collectionWithDelegate) + rent(model.sizes.reservedAsset) + rent(652) + rent(model.sizes.guard);
  assert.equal(result.estimates.accountRentLamports, String(accountRent));
  assert.equal(result.estimates.networkFeesLamports, '30000');
  assert.equal(result.estimates.fullDeploymentLamports, String(accountRent + 30000 + 1500000));
  assert.equal(result.estimates.remainingSteps, 3); assert.equal(result.quoteWindows.length, 1);
  assert.equal(result.model.privateMappingVerified, false); assert.equal(result.budgetComplete, false);
  assert.equal(result.fundingRecommendationLamports, null); assert.deepEqual(await readDeploymentJournal(directory), before);
});

test('preflight and unsigned exact-message simulation support hidden mode; changed rent or trusted hash blocks', async t => {
  const directory = await journal(t), f = fixture();
  const read = await preflightDeploymentStep({ directory, stepId: 'collection-create', endpoint, fetchImpl: f.fetchImpl });
  safe(read); assert.equal(read.status, 'read-checks-passed'); assert.equal(read.budget.machineSpace, 652);
  const simulated = await simulateDeploymentStep({ directory, stepId: 'collection-create', mode: 'unsigned', endpoint, fetchImpl: f.fetchImpl });
  safe(simulated); assert.equal(simulated.status, 'simulation-passed'); assert.equal(simulated.unitsConsumed, 4242);
  const changed = fixture({ getMinimumBalanceForRentExemption: rent(652) + 1 });
  const failed = await quoteDeploymentBudget({ directory, endpoint, fetchImpl: changed.fetchImpl });
  assert.equal(failed.status, 'blocked'); assert.equal(failed.code, 'MACHINE_RENT_CHANGED_REBUILD_PLAN');
  const forbidden = fixture();
  const mismatched = await quoteDeploymentBudget({ directory, endpoint, fetchImpl: forbidden.fetchImpl,
    trustedHiddenCommitmentSha256: 'a'.repeat(64) });
  assert.equal(mismatched.status, 'blocked'); assert.equal(mismatched.code, 'DEPLOYMENT_INTENT_INVALID');
  assert.equal(forbidden.calls.length, 0);
});

test('completed hidden deployment verifies collection delegate, reserve, 652-byte machine and closed guard together', async () => {
  const accounts = hiddenAccountFixtures({ policy, storageOptions: input, roles: plan.roles });
  const reserve = plan.steps[1].expected;
  const reserveAccount = fixtureRpcAccount(getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1,
    owner: reserve.owner, updateAuthority: { __kind: 'Collection', fields: [reserve.collection] },
    name: reserve.name, uri: reserve.uri, seq: none() }), MPL_CORE_PROGRAM_ID);
  const values = [{ executable: true }, { executable: true }, { executable: true },
    accounts.collectionAccount(0), reserveAccount, accounts.machineAccount(), accounts.guardAccount()];
  const read = custom => ({ async call(method, params) {
    assert.equal(method, 'getMultipleAccounts'); assert.equal(params[0].length, 7);
    assert.equal(params[1].commitment, 'finalized');
    return { context: { slot: 600 }, value: custom };
  } });
  assert.equal(await checkDeploymentState(read(values), plan, 2), 600);
  for (const [index, account] of [[5, null], [6, null], [5, accounts.machineAccount(1)],
    [6, accounts.guardAccount(1n)], [3, accounts.collectionAccount(1)]]) {
    const changed = [...values]; changed[index] = account;
    await assert.rejects(checkDeploymentState(read(changed), plan, 2), { code: 'EXPECTED_ACCOUNT_STATE_MISMATCH' });
  }
  const changedPlan = structuredClone(plan); changedPlan.steps[2].expected.hiddenSettings.hash = 'f'.repeat(64);
  await assert.rejects(checkDeploymentState(read(values), changedPlan, 2), { code: 'EXPECTED_ACCOUNT_STATE_MISMATCH' });
});

test('ephemeral hidden signer vault and bundle bind the hash and preserve old custody envelope without production secrets', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-hidden-vault-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phrase = Buffer.from('temporary hidden compatibility TEST phrase');
  const created = await createDeploymentSignerVault({ id: 'hidden-vault-TEST', cluster: 'devnet',
    blockhash: input.blockhash, lastValidBlockHeight: 1000, machineRentLamports: input.machineRentLamports,
    storageMode: input.storageMode, hiddenCommitmentSha256: commitment, passphrase: phrase });
  assert.equal(created.manifest.steps.length, 3); assert.equal(created.vault.version, 1);
  const directory = path.join(root, 'bundle'); await createDeploymentBundle({ directory, ...created });
  const before = await readFile(path.join(directory, 'journal/manifest.json'));
  const bundle = await readDeploymentBundle(directory);
  const handle = await openDeploymentSignerVault({ vault: bundle.vault, manifest: bundle.snapshot.manifest, passphrase: phrase });
  handle.dispose();
  const altered = structuredClone(created.manifest); altered.steps[2].expected.hiddenSettings.hash = 'b'.repeat(64);
  await assert.rejects(openDeploymentSignerVault({ vault: created.vault, manifest: altered, passphrase: phrase }), { code: 'DEPLOYMENT_VAULT_INVALID' });
  assert.deepEqual(await readFile(path.join(directory, 'journal/manifest.json')), before); phrase.fill(0);
});
