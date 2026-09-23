import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, readDeploymentJournal, nextDeploymentAction } from '../deployment/journal.mjs';
import { signingGroupId, verifySigningGroupResponse } from '../deployment/group-signing.mjs';
import { createOwnerClient } from '../deployment/owner-console/client.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { insertionAccounts } from './fixtures/group-accounts.mjs';
import { seedVerifiedPrefix, fixtureProof } from './fixtures/group-journal.mjs';
const key = n => Keypair.fromSeed(createHash('sha256').update(`group-fixture-${n}`).digest());
const owner = key('owner'), passphrase = Buffer.from('group-fixture-password-only'), endpoint = 'https://group-fixture.test/rpc';
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
let fixture, prepareDeploymentGroup, createSigningSession, sendDeploymentStep, resumeDeploymentStep;
before(async () => {
  policy.owner = owner.publicKey.toBase58(); globalThis.fetch = () => assert.fail('Live network forbidden');
  ({ prepareDeploymentGroup } = await import('../deployment/group.mjs'));
  ({ createSigningSession } = await import('../deployment/owner-console/session.mjs'));
  ({ sendDeploymentStep, resumeDeploymentStep } = await import('../deployment/sender.mjs'));
  fixture = await createDeploymentSignerVault({ id: 'group-fixture', cluster: 'devnet',
    blockhash: key('old').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000', passphrase });
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'deployment-group-')), directory = path.join(root, 'bundle');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  await seedVerifiedPrefix({ fixture, passphrase, owner, journalDirectory });
  const calls = []; let loaded = 0, expired = false, badSimulation = false, sent = null, loseSend = false;
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    let result;
    if (call.method === 'sendTransaction') {
      assert.equal(call.params[1].maxRetries, 0);
      const saved = await readDeploymentJournal(journalDirectory), current = nextDeploymentAction(saved);
      const attempt = saved.steps.find(s => s.id === current.stepId).attempts.at(-1);
      assert.equal(attempt.state, 'send-claimed'); assert.equal(attempt.signed.transactionBase64, call.params[0]);
      sent = attempt.signed; loaded += saved.manifest.steps.find(s => s.id === current.stepId).expected.count;
      if (loseSend) throw Error('Fixture lost response');
      result = sent.signature;
    } else result = {
      getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 600 }, value: insertionAccounts(fixture.manifest, loaded) },
      getBalance: { context: { slot: 600 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash: key('fresh').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 5000 }, isBlockhashValid: { context: { slot: 600 }, value: !expired },
      getBlockHeight: expired ? 2001 : 1500,
      simulateTransaction: { context: { slot: 600 }, value: { err: badSimulation ? 'FixtureFailure' : null, unitsConsumed: 5000 } },
      getSignatureStatuses: { context: { slot: 600 }, value: sent ? [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }] : [null] },
      getTransaction: sent ? { slot: 500, version: 0, meta: { err: null }, transaction: [sent.transactionBase64, 'base64'] } : null,
    }[call.method];
    assert.notEqual(result, undefined, call.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  };
  const options = { directory, endpoint, fetchImpl };
  return { ...options, journalDirectory, calls, options, snapshot: () => readDeploymentJournal(journalDirectory),
    expire: () => { expired = true; }, failSimulation: () => { badSimulation = true; },
    loseSend: () => { loseSend = true; }, prepare: count => prepareDeploymentGroup({ ...options, count }) };
}
function sign(requests) {
  return requests.map(request => { const tx = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
    tx.sign([owner]); return Buffer.from(tx.serialize()).toString('base64'); });
}
test('one group survives lost replies and restart; exact sender advances only after finalized verification', async t => {
  const h = await harness(t), prepared = await h.prepare(2);
  assert.equal(prepared.count, 2); assert.equal(prepared.estimatedGroupFeesLamports, '10000');
  assert.equal((await h.snapshot()).revision, 10);
  let session = await createSigningSession(h.options), state = await session.state();
  const checked = await session.check(state.requestId), bytes = sign(checked.requests);
  assert.equal((await h.snapshot()).revision, 11);
  await assert.rejects(session.accept(state.requestId, bytes.slice(0, 1)));
  await assert.rejects(session.accept(state.requestId, [...bytes].reverse()));
  await assert.rejects(session.accept(state.requestId, [bytes[0], bytes[0]]));
  assert.equal((await h.snapshot()).revision, 11);
  assert.equal((await session.accept(state.requestId, bytes)).signed, true);
  session = await createSigningSession(h.options); assert.equal((await session.accept(state.requestId, bytes)).alreadySaved, true);
  assert.equal((await h.snapshot()).revision, 12);
  const first = checked.requests[0].stepId, second = checked.requests[1].stepId;
  const beforeCalls = h.calls.length;
  assert.equal((await sendDeploymentStep({ ...h.options, stepId: second, authorizeDevnetSend: true })).status, 'blocked');
  assert.equal(h.calls.length, beforeCalls);
  h.loseSend();
  assert.equal((await sendDeploymentStep({ ...h.options, stepId: first, authorizeDevnetSend: true })).status, 'unknown');
  assert.equal(nextDeploymentAction(await h.snapshot()).stepId, first);
  assert.equal((await sendDeploymentStep({ ...h.options, stepId: first, authorizeDevnetSend: true })).status, 'blocked');
  assert.equal((await resumeDeploymentStep({ ...h.options, stepId: first })).status, 'verified');
  assert.equal(nextDeploymentAction(await h.snapshot()).stepId, second);
  assert.equal(h.calls.filter(x => x.method === 'sendTransaction').length, 1);
  h.expire();
  assert.equal((await sendDeploymentStep({ ...h.options, stepId: second, authorizeDevnetSend: true })).status, 'blocked');
  assert.equal(h.calls.filter(x => x.method === 'sendTransaction').length, 1);
  assert.equal((await session.state()).progress.verifiedSteps, 4);
});

test('group claims are durable and atomic; a failed first member never skips to later signed members', async t => {
  const h = await harness(t); await h.prepare(4);
  let session = await createSigningSession(h.options), state = await session.state(), checked = await session.check(state.requestId);
  session = await createSigningSession(h.options); await assert.rejects(session.check(state.requestId));
  await assert.rejects(session.decline(state.requestId, '0'.repeat(64)));
  assert.equal((await session.decline(state.requestId, checked.claimId)).walletRequested, false);
  checked = await session.check(state.requestId); const bytes = sign(checked.requests);
  let snapshot = await h.snapshot();
  await assert.rejects(appendDeploymentEvent(h.journalDirectory, { type: 'signed', stepId: checked.requests[0].stepId,
    attempt: 1, transactionBase64: bytes[0] }, { expectedRevision: snapshot.revision }));
  await mkdir(path.join(h.journalDirectory, '.writer-lock'), { mode: 0o700 });
  await assert.rejects(session.accept(state.requestId, bytes));
  await rm(path.join(h.journalDirectory, '.writer-lock'), { recursive: true }); // this fixture's lock only
  assert.equal((await h.snapshot()).revision, snapshot.revision);
  await session.accept(state.requestId, bytes); snapshot = await h.snapshot();
  const first = checked.requests[0].stepId;
  await appendDeploymentEvent(h.journalDirectory, { type: 'reconcile', stepId: first, attempt: 1,
    proof: fixtureProof(snapshot, 3, 'failed') }, { expectedRevision: snapshot.revision });
  snapshot = await h.snapshot(); assert.deepEqual(nextDeploymentAction(snapshot), { type: 'retry-review', stepId: first });
  await assert.rejects(appendDeploymentEvent(h.journalDirectory, { type: 'claim-send', stepId: checked.requests[1].stepId,
    attempt: 1 }, { expectedRevision: snapshot.revision }));
  const count = h.calls.length; await assert.rejects(h.prepare(2)); assert.equal(h.calls.length, count);
});

test('bad simulations, existing work and invalid sizes never persist a group or dispatch a signature', async t => {
  const h = await harness(t), before = await h.snapshot();
  for (const count of [0, 1, 5, 50, '2']) await assert.rejects(h.prepare(count));
  assert.equal(h.calls.length, 0);
  h.failSimulation(); await assert.rejects(h.prepare(2)); assert.deepEqual(await h.snapshot(), before);
});

test('Wallet Standard receives one bounded variadic request; lost group save restores without signing again', async t => {
  const h = await harness(t); await h.prepare(2);
  const session = await createSigningSession(h.options), values = new Map(); let lost = true, invocations = 0;
  const api = async (route, body) => {
    if (route === '/api/state') return session.state();
    if (route === '/api/check') return session.check(body.requestId);
    if (route === '/api/group-signature') { const result = await session.accept(body.requestId, body.transactionBase64s);
      if (lost) throw Error('Lost fixture acknowledgment'); return result; }
    assert.fail(route);
  };
  const storage = { ready: async () => {}, get: async id => values.get(id), put: async (id, value) => { values.set(id, structuredClone(value)); } };
  const account = { address: owner.publicKey.toBase58(), publicKey: owner.publicKey.toBytes(), chains: ['solana:devnet'], features: ['solana:signTransaction'] };
  const wallet = { name: 'Group Fixture', chains: account.chains, accounts: [account], features: {
    'standard:connect': { connect: async () => {} }, 'standard:events': { on: () => () => {} },
    'solana:signTransaction': { supportedTransactionVersions: [0], async signTransaction(...inputs) {
      invocations++; assert.equal(inputs.length, 2); assert.equal([...values.values()][0].status, 'wallet-pending');
      return inputs.map(input => { assert.equal(input.chain, 'solana:devnet'); const tx = VersionedTransaction.deserialize(input.transaction);
        tx.sign([owner]); return { signedTransaction: tx.serialize() }; });
    } }, 'solana:signAndSendTransaction': { signAndSendTransaction: () => assert.fail('No wallet send') },
  } };
  const client = createOwnerClient({ api, storage }); await client.load(); await client.connect(wallet);
  await assert.rejects(client.sign()); assert.equal(invocations, 1); assert.equal(client.state().canRecover, true);
  const exported = client.exportResponse(); assert.equal(signingGroupId(exported.requests), exported.groupId);
  assert.equal(verifySigningGroupResponse(exported.requests, exported.transactionBase64s).length, 2);
  lost = false; await client.recover(); const saved = await h.snapshot();
  const restarted = createOwnerClient({ api, storage }); await restarted.load(); await restarted.connect(wallet);
  await assert.rejects(restarted.sign()); assert.equal(invocations, 1); assert.deepEqual(await h.snapshot(), saved);
});
