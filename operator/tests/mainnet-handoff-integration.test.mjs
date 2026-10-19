// Hidden Settings Mainnet intent exercised only with synthetic vault/RPC data.
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
import { readDeploymentJournal } from '../deployment/journal.mjs';
import { prepareDeploymentSigning, readPendingDeploymentSigning } from '../deployment/handoff.mjs';
import { simulateDeploymentStep } from '../deployment/simulation.mjs';
import { quoteDeploymentBudget } from '../deployment/budget.mjs';
import { queueBinding } from '../deployment/queue.mjs';
import { GENESIS_HASHES } from '../deployment/network.mjs';
const key = label => Keypair.fromSeed(createHash('sha256').update('mainnet-hidden-handoff-TEST:' + label).digest());
const owner = key('owner'), passphrase = Buffer.from('synthetic-mainnet-hidden-handoff-passphrase');
const commitment = createHash('sha256').update('synthetic mapping, never production').digest('hex');
const endpoint = 'https://mainnet-hidden-handoff-fixture.test/rpc';
const oldOwner = policy.owner, originalFetch = globalThis.fetch;
let fixture;
before(async () => {
  globalThis.fetch = () => assert.fail('Live network forbidden'); policy.owner = owner.publicKey.toBase58();
  fixture = await createDeploymentSignerVault({ id: 'mainnet-hidden-handoff-TEST', cluster: 'mainnet-beta',
    blockhash: key('old-hash').publicKey.toBase58(), lastValidBlockHeight: 1000,
    machineRentLamports: '3962400', passphrase, storageMode: 'hidden-settings', hiddenCommitmentSha256: commitment });
});
after(() => { policy.owner = oldOwner; globalThis.fetch = originalFetch; });
async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mainnet-hidden-handoff-')), directory = path.join(root, 'bundle');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  const calls = []; let genesis = GENESIS_HASHES['mainnet-beta'];
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    assert.doesNotMatch(call.method, /send|reviewDeployment/);
    const results = {
      getGenesisHash: genesis,
      getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
      getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5080 * (Number(call.params[0]) + 128),
      getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('fresh-hash').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 513 }, value: 10000 },
      isBlockhashValid: { context: { slot: 514 }, value: true }, getBlockHeight: 1500,
      simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    };
    assert.ok(Object.hasOwn(results, call.method), call.method);
    return Response.json({ jsonrpc: '2.0', id: call.id, result: results[call.method] });
  };
  return { directory, journalDirectory, calls, snapshot: () => readDeploymentJournal(journalDirectory),
    options: { directory, stepId: 'collection-create', endpoint, fetchImpl, passphrase,
      authorizeMainnet: true, trustedHiddenCommitmentSha256: commitment },
    wrongGenesis: () => { genesis = GENESIS_HASHES.devnet; } };
}
test('explicit Mainnet grant and independently supplied hidden commitment prepare only a durable unsigned-owner request', async t => {
  const h = await harness(t), baseline = await h.snapshot();
  const prepared = await prepareDeploymentSigning({ ...h.options, expectedBinding: queueBinding(baseline) });
  assert.equal(prepared.request.cluster, 'mainnet-beta'); assert.equal(prepared.preflight.cluster, 'mainnet-beta');
  assert.equal(prepared.preflight.genesisHash, GENESIS_HASHES['mainnet-beta']); assert.equal(prepared.simulationVerified, true);
  assert.equal(prepared.transactionsSent, 0); assert.equal(prepared.readyToSubmit, false); assert.equal(prepared.salesOpen, false);
  const saved = await h.snapshot(); assert.equal(saved.revision, 1); assert.equal(saved.steps.length, 3);
  assert.equal(saved.steps[0].attempts[0].signed, null);
  const resumed = await readPendingDeploymentSigning(h.directory); assert.deepEqual(resumed.request, prepared.request);
  assert.deepEqual(await h.snapshot(), saved);
});
test('missing grant, wrong trusted commitment and changed snapshot fail before RPC or journal mutation', async t => {
  const h = await harness(t), baseline = await h.snapshot();
  for (const authorizeMainnet of [false, 'true']) await assert.rejects(prepareDeploymentSigning({ ...h.options, authorizeMainnet }));
  for (const trustedHiddenCommitmentSha256 of [undefined, '0'.repeat(64), 'b'.repeat(64)])
    await assert.rejects(prepareDeploymentSigning({ ...h.options, trustedHiddenCommitmentSha256 }));
  await assert.rejects(prepareDeploymentSigning({ ...h.options, expectedBinding: { ...queueBinding(baseline), expectedRevision: 1 } }));
  assert.equal(h.calls.length, 0); assert.deepEqual(await h.snapshot(), baseline);
  const report = await simulateDeploymentStep({ directory: h.journalDirectory, stepId: 'collection-create', mode: 'unsigned',
    endpoint, fetchImpl: h.options.fetchImpl, trustedHiddenCommitmentSha256: commitment });
  assert.equal(report.status, 'blocked'); assert.equal(report.networkRequests, 0); assert.equal(report.transactionsSent, 0);
  assert.deepEqual(await h.snapshot(), baseline);
});
test('a Devnet genesis cannot satisfy an authorized Mainnet hidden simulation or publish a request', async t => {
  const h = await harness(t), baseline = await h.snapshot(); h.wrongGenesis();
  await assert.rejects(prepareDeploymentSigning(h.options));
  assert.deepEqual(h.calls.map(call => call.method), ['getGenesisHash']); assert.deepEqual(await h.snapshot(), baseline);
});
test('Mainnet hidden budget remains a read-only estimate with explicit network and external commitment binding', async t => {
  const h = await harness(t), baseline = await h.snapshot();
  const options = { directory: h.journalDirectory, endpoint, fetchImpl: h.options.fetchImpl,
    trustedHiddenCommitmentSha256: commitment };
  const blocked = await quoteDeploymentBudget(options);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.networkRequests, 0); assert.equal(h.calls.length, 0);
  const report = await quoteDeploymentBudget({ ...options, authorizeMainnet: true });
  assert.equal(report.status, 'budget-estimated'); assert.equal(report.cluster, 'mainnet-beta');
  assert.equal(report.genesisHash, GENESIS_HASHES['mainnet-beta']); assert.equal(report.steps.length, 3);
  assert.equal(report.budgetComplete, false); assert.equal(report.readyToSubmit, false); assert.equal(report.salesOpen, false);
  assert.equal(report.transactionsSent, 0); assert.equal(report.journalWrites, 0); assert.deepEqual(await h.snapshot(), baseline);
});
