// Offline integration of custody, canonical intent, read-only RPC fixtures,
// real partial/owner signatures and the durable local journal. No live wallet.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { readDeploymentJournal, appendDeploymentEvent } from '../deployment/journal.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';

const key = label => Keypair.fromSeed(createHash('sha256').update(`handoff-offline-fixture:${label}`).digest());
const owner = key('owner');
const oldHash = key('old-blockhash').publicKey.toBase58(), freshHash = key('fresh-blockhash').publicKey.toBase58();
const passphrase = Buffer.from('offline-handoff-test-passphrase-32-bytes');
const endpoint = 'https://rpc-fixture.example/rpc?api-key=fixture-private-token';
const stepId = 'collection-create';
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
const encode = transaction => Buffer.from(transaction.serialize()).toString('base64');
const decode = value => VersionedTransaction.deserialize(Buffer.from(value, 'base64'));
let fixture, prepareDeploymentSigning, acceptDeploymentSigningResponse, readPendingDeploymentSigning, liveCalls = 0;

before(async () => {
  // Only this Node worker's in-memory fixture owner changes. No owner private
  // key or file policy is read/changed, and no real custody bundle is created.
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  ({ prepareDeploymentSigning, acceptDeploymentSigningResponse, readPendingDeploymentSigning } = await import('../deployment/handoff.mjs'));
  fixture = await createDeploymentSignerVault({ id: 'handoff-fixture', cluster: 'devnet', blockhash: oldHash,
    lastValidBlockHeight: 1000, machineRentLamports: '5000000000', passphrase });
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

async function harness(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-handoff-fixture-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'bundle');
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  const h = { directory, journalDirectory, snapshot: () => readDeploymentJournal(journalDirectory) };
  h.append = async (type, fields = {}) => {
    const snapshot = await h.snapshot();
    return appendDeploymentEvent(journalDirectory, { type, stepId, attempt: 1, ...fields }, { expectedRevision: snapshot.revision });
  };
  return h;
}
function rpcFixture({ override = {}, onCall } = {}) {
  const calls = [];
  const results = {
    getGenesisHash: GENESIS_HASHES.devnet,
    getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
    getBalance: { context: { slot: 511 }, value: 10000000000 },
    getMinimumBalanceForRentExemption: 5000000000,
    getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: freshHash, lastValidBlockHeight: 2000 } },
    getFeeForMessage: { context: { slot: 513 }, value: 10000 },
    isBlockhashValid: { context: { slot: 514 }, value: true },
    getBlockHeight: 1500,
    ...override,
  };
  return { calls, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    assert.equal(url, endpoint); assert.equal(options.method, 'POST');
    assert.ok(Object.hasOwn(results, request.method), `Unexpected RPC method ${request.method}`);
    await onCall?.(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } };
}
const prepare = (h, rpc, extra = {}) => prepareDeploymentSigning({ directory: h.directory, stepId, passphrase, endpoint, fetchImpl: rpc.fetchImpl, ...extra });
const responseFor = request => {
  const transaction = decode(request.transactionBase64); transaction.sign([owner]);
  return { transactionBase64: encode(transaction) };
};
const accept = (h, request, response = responseFor(request)) => acceptDeploymentSigningResponse({ directory: h.directory, request, response });
function limited(result) {
  for (const flag of ['readyToSubmit', 'budgetComplete', 'simulationVerified', 'lifetimeGuaranteed', 'salesOpen']) assert.equal(result[flag], false);
  assert.equal(result.transactionsSent, 0);
  const printable = JSON.stringify(result);
  assert.equal(printable.includes('fixture-private-token'), false); assert.equal(printable.includes(passphrase.toString()), false);
}
function fixedError(expected) {
  return error => {
    assert.match(error.code, /^DEPLOYMENT_HANDOFF_[A-Z_]+$/); assert.equal(error.message, error.code);
    if (expected) assert.equal(error.code, `DEPLOYMENT_HANDOFF_${expected}`);
    assert.equal('cause' in error, false); return true;
  };
}

test('prepare persists exact partial request before release; reload and owner acceptance preserve durable bytes', async t => {
  const h = await harness(t), rpc = rpcFixture(), beforePassphrase = Buffer.from(passphrase);
  const prepared = await prepare(h, rpc); limited(prepared);
  assert.deepEqual(passphrase, beforePassphrase);
  assert.equal(prepared.preflight.status, 'read-checks-passed'); assert.equal(rpc.calls.length, 8);
  const snapshot = await h.snapshot(), attempt = snapshot.steps[0].attempts[0];
  assert.equal(snapshot.revision, 1); assert.equal(attempt.state, 'wallet-pending'); assert.deepEqual(attempt.request, prepared.request);
  assert.equal(prepared.binding.expectedRevision, snapshot.revision); assert.equal(prepared.binding.expectedHeadHash, snapshot.headHash);
  const transaction = decode(prepared.request.transactionBase64);
  assert.ok(transaction.signatures[0].every(byte => byte === 0)); assert.ok(transaction.signatures[1].some(Boolean));
  assert.equal(prepared.request.blockhash, freshHash); assert.equal(prepared.request.attempt, 1);
  const resumed = await readPendingDeploymentSigning(h.directory); limited(resumed);
  assert.deepEqual(resumed.request, prepared.request); assert.deepEqual(resumed.binding, prepared.binding); assert.equal(rpc.calls.length, 8);
  const response = responseFor(resumed.request), accepted = await accept(h, resumed.request, response); limited(accepted);
  const signed = await h.snapshot(); assert.equal(signed.revision, 2); assert.equal(accepted.state, 'signed');
  assert.equal(signed.steps[0].attempts[0].signed.signature, accepted.signature);
  assert.equal(signed.steps[0].attempts[0].signed.transactionBase64, response.transactionBase64);
  assert.deepEqual(signed.steps[0].attempts[0].request, resumed.request);
  await assert.rejects(readPendingDeploymentSigning(h.directory), fixedError('RECONCILIATION_REQUIRED'));
  assert.equal(rpc.calls.length, 8);
});

test('wrong passphrase authenticates before RPC and caller-supplied preflight evidence is rejected', async t => {
  const h = await harness(t), rpc = rpcFixture(), initial = await h.snapshot();
  const wrong = Buffer.from('incorrect-offline-fixture-passphrase');
  await assert.rejects(prepare(h, rpc, { passphrase: wrong }), fixedError('VAULT_INVALID'));
  assert.equal(wrong.toString(), 'incorrect-offline-fixture-passphrase');
  await assert.rejects(prepare(h, rpc, { preflight: { status: 'read-checks-passed' } }), fixedError('INVALID_INPUT'));
  assert.equal(rpc.calls.length, 0); assert.deepEqual(await h.snapshot(), initial);
  const badRpc = rpcFixture({ override: { getGenesisHash: GENESIS_HASHES['mainnet-beta'] } });
  await assert.rejects(prepare(h, badRpc), fixedError('PREFLIGHT_BLOCKED'));
  assert.equal(badRpc.calls.length, 1); assert.deepEqual(await h.snapshot(), initial);
});

test('already durable pending request is recovered exactly; second prepare does no RPC and forged responses write nothing', async t => {
  const h = await harness(t), prepared = await prepare(h, rpcFixture()), before = await h.snapshot();
  // This is also the recovery cut where the first caller lost the successful
  // return after durable prepare: the saved request is the sole continuation.
  const secondRpc = rpcFixture();
  await assert.rejects(prepare(h, secondRpc), fixedError('RECONCILIATION_REQUIRED'));
  await assert.rejects(prepare(h, secondRpc, { retry: true }), fixedError('RECONCILIATION_REQUIRED'));
  assert.equal(secondRpc.calls.length, 0);
  const resumed = await readPendingDeploymentSigning(h.directory); assert.deepEqual(resumed.request, prepared.request);
  await assert.rejects(accept(h, { ...prepared.request, messageSha256: 'a'.repeat(64) }, responseFor(prepared.request)), fixedError('REQUEST_MISMATCH'));
  const changed = decode(prepared.request.transactionBase64); changed.message.recentBlockhash = oldHash; changed.sign([owner]);
  await assert.rejects(accept(h, prepared.request, { transactionBase64: encode(changed) }), fixedError('SIGNING_RESPONSE_INVALID'));
  const cleared = decode(responseFor(prepared.request).transactionBase64); cleared.signatures[1].fill(0);
  await assert.rejects(accept(h, prepared.request, { transactionBase64: encode(cleared) }), fixedError('SIGNING_RESPONSE_INVALID'));
  assert.deepEqual(await h.snapshot(), before);
  const results = await Promise.allSettled([accept(h, prepared.request), accept(h, prepared.request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await h.snapshot()).revision, 2);
});

test('journal head advancing during actual preflight prevents a second request from escaping', async t => {
  const h = await harness(t);
  const signer = await openDeploymentSignerVault({ ...fixture, passphrase });
  let competing;
  try {
    const transaction = decode(fixture.manifest.steps[0].transactionBase64); transaction.message.recentBlockhash = freshHash;
    competing = signer.partialSign({ stepId, transactionBase64: encode(transaction), lastValidBlockHeight: 2000, attempt: 1 });
  } finally { signer.dispose(); }
  const rpc = rpcFixture({ onCall: async request => {
    if (request.method === 'getBlockHeight') await appendDeploymentEvent(h.journalDirectory,
      { type: 'prepare', stepId, request: competing, retry: false }, { expectedRevision: 0 });
  } });
  await assert.rejects(prepare(h, rpc), fixedError('PREFLIGHT_BLOCKED'));
  const snapshot = await h.snapshot(); assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.steps[0].attempts[0].request, competing);
  assert.deepEqual((await readPendingDeploymentSigning(h.directory)).request, competing);
});

test('late owner signature is saved in unknown state without reissue, RPC or submission authorization', async t => {
  const h = await harness(t), rpc = rpcFixture(), { request } = await prepare(h, rpc);
  await h.append('unknown');
  const accepted = await accept(h, request); limited(accepted); assert.equal(accepted.state, 'unknown');
  const snapshot = await h.snapshot(); assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.steps[0].attempts[0].state, 'unknown');
  assert.equal(snapshot.steps[0].attempts[0].signed.signature, accepted.signature);
  const noRpc = rpcFixture();
  await assert.rejects(prepare(h, noRpc, { retry: true }), fixedError('RECONCILIATION_REQUIRED'));
  await assert.rejects(readPendingDeploymentSigning(h.directory), fixedError('RECONCILIATION_REQUIRED'));
  assert.equal(noRpc.calls.length, 0); assert.equal(rpc.calls.length, 8); assert.deepEqual(await h.snapshot(), snapshot);
});

test('retry requires explicit intent and new attempt; old owner response cannot replace current saved request', async t => {
  const h = await harness(t), first = await prepare(h, rpcFixture());
  await h.append('cancelled');
  const rpc = rpcFixture();
  await assert.rejects(prepare(h, rpc), fixedError('EXPLICIT_RETRY_REQUIRED')); assert.equal(rpc.calls.length, 0);
  const second = await prepare(h, rpc, { retry: true }); assert.equal(second.request.attempt, 2); assert.equal(rpc.calls.length, 8);
  const before = await h.snapshot();
  assert.equal(before.steps[0].attempts.length, 2); assert.equal(before.steps[0].attempts[0].state, 'cancelled');
  assert.deepEqual(before.steps[0].attempts[0].request, first.request);
  await assert.rejects(accept(h, first.request), fixedError('REQUEST_MISMATCH'));
  assert.deepEqual(await h.snapshot(), before); assert.deepEqual((await readPendingDeploymentSigning(h.directory)).request, second.request);
});
