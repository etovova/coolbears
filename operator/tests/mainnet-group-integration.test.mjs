// Synthetic disposable signatures and intercepted RPC only; no chain execution.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, readDeploymentJournal, deploymentGroupAttempts } from '../deployment/journal.mjs';
import { validateSigningGroup, signingGroupId } from '../deployment/group-signing.mjs';
import { queueBinding } from '../deployment/queue.mjs';
import { GENESIS_HASHES } from '../deployment/network.mjs';
import { insertionAccounts } from './fixtures/group-accounts.mjs';
import { seedVerifiedPrefix } from './fixtures/group-journal.mjs';
const key = label => Keypair.fromSeed(createHash('sha256').update('mainnet-group-fixture:' + label).digest());
const owner = key('owner'), passphrase = Buffer.from('synthetic-mainnet-group-passphrase');
const endpoint = 'https://mainnet-group-fixture.test/rpc';
const oldOwner = policy.owner, originalFetch = globalThis.fetch;
let fixture, checkDeploymentGroup, prepareDeploymentGroup;
before(async () => {
  globalThis.fetch = () => assert.fail('Live network forbidden'); policy.owner = owner.publicKey.toBase58();
  // The legacy verifier captures its approved owner at module initialization.
  // Initialize it only after selecting this process's disposable fixture owner.
  ({ checkDeploymentGroup, prepareDeploymentGroup } = await import('../deployment/group.mjs'));
  fixture = await createDeploymentSignerVault({ id: 'mainnet-group-fixture', cluster: 'mainnet-beta',
    blockhash: key('old-hash').publicKey.toBase58(), lastValidBlockHeight: 1000,
    machineRentLamports: '5000000000', passphrase });
});
after(() => { policy.owner = oldOwner; globalThis.fetch = originalFetch; });
async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mainnet-group-integration-')), directory = path.join(root, 'bundle');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  await seedVerifiedPrefix({ fixture, passphrase, owner, journalDirectory });
  const calls = []; let genesis = GENESIS_HASHES['mainnet-beta'];
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    assert.doesNotMatch(call.method, /send|reviewDeployment/);
    const results = {
      getGenesisHash: genesis,
      getMultipleAccounts: { context: { slot: 600 }, value: insertionAccounts(fixture.manifest, 0) },
      getBalance: { context: { slot: 600 }, value: 10000000000 },
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash: key('fresh-hash').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 5000 },
      isBlockhashValid: { context: { slot: 600 }, value: true }, getBlockHeight: 1500,
      simulateTransaction: { context: { slot: 600 }, value: { err: null, unitsConsumed: 5000 } },
    };
    assert.ok(Object.hasOwn(results, call.method), call.method);
    return Response.json({ jsonrpc: '2.0', id: call.id, result: results[call.method] });
  };
  return { directory, journalDirectory, calls, fetchImpl,
    options: { directory, endpoint, fetchImpl, authorizeMainnet: true },
    snapshot: () => readDeploymentJournal(journalDirectory), wrongGenesis: () => { genesis = GENESIS_HASHES.devnet; } };
}
test('Mainnet group preparation is pinned to its trusted snapshot and survives unchanged replay', async t => {
  const h = await harness(t), baseline = await h.snapshot();
  const report = await prepareDeploymentGroup({ ...h.options, count: 2, expectedBinding: queueBinding(baseline) });
  assert.equal(report.status, 'group-saved'); assert.equal(report.transactionsSent, 0); assert.equal(report.salesOpen, false);
  assert.equal(report.cluster, 'mainnet-beta'); assert.equal(report.genesisHash, GENESIS_HASHES['mainnet-beta']);
  const saved = await h.snapshot(), entries = deploymentGroupAttempts(saved, report.groupId);
  assert.equal(saved.revision, baseline.revision + 1); assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.attempt.request.cluster === 'mainnet-beta' && entry.attempt.state === 'wallet-pending'));
  assert.equal(signingGroupId(entries.map(entry => entry.attempt.request)), report.groupId);
  assert.deepEqual(await h.snapshot(), saved);
});
test('missing Mainnet read permission, wrong genesis and changed snapshot never append a group', async t => {
  const h = await harness(t), baseline = await h.snapshot(), binding = queueBinding(baseline);
  for (const authorizeMainnet of [false, 'true']) await assert.rejects(prepareDeploymentGroup({ ...h.options, count: 2, authorizeMainnet }));
  assert.equal(h.calls.length, 0);
  for (const expectedBinding of [null, {}, { ...binding, cluster: 'mainnet-beta' }, { ...binding, expectedRevision: binding.expectedRevision + 1 },
    { ...binding, manifestSha256: '0'.repeat(64) }, { ...binding, expectedHeadHash: '0'.repeat(64) }])
    await assert.rejects(prepareDeploymentGroup({ ...h.options, count: 2, expectedBinding }));
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.snapshot(), baseline);
  h.wrongGenesis(); await assert.rejects(prepareDeploymentGroup({ ...h.options, count: 2 }));
  assert.deepEqual(h.calls.map(call => call.method), ['getGenesisHash']); assert.deepEqual(await h.snapshot(), baseline);
});
test('mixed group networks and a uniformly wrong journal network fail atomically before durable publication', async t => {
  const h = await harness(t), baseline = await h.snapshot(), checked = await checkDeploymentGroup({ ...h.options, count: 2 });
  const mixed = structuredClone(checked.requests); mixed[1].cluster = 'devnet';
  assert.throws(() => validateSigningGroup(mixed)); assert.throws(() => signingGroupId(mixed));
  await assert.rejects(appendDeploymentEvent(h.journalDirectory, { type: 'prepare-group', stepId: checked.requests[0].stepId,
    groupId: checked.groupId, requests: mixed }, { expectedRevision: baseline.revision }));
  const other = checked.requests.map(request => ({ ...request, cluster: 'devnet' }));
  await assert.rejects(appendDeploymentEvent(h.journalDirectory, { type: 'prepare-group', stepId: other[0].stepId,
    groupId: signingGroupId(other), requests: other }, { expectedRevision: baseline.revision }));
  assert.deepEqual(await h.snapshot(), baseline);
});
