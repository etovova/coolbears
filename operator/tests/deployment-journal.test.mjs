// Real filesystem and real local signatures; all reconciliation proofs below
// are synthetic adapter fixtures, never claims of actual on-chain deployment.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createSigningRequest } from '../deployment/signing.mjs';
import { appendDeploymentEvent, createDeploymentJournal, nextDeploymentAction,
  readDeploymentJournal, sha256Json } from '../deployment/journal.mjs';

let originalFetch, fetchCalls = 0;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw Error('Network forbidden in deployment journal tests'); };
});
after(() => { globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0); });

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blockhash = byte => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const last = (snapshot, stepId = snapshot.manifest.steps[0].id) => snapshot.steps.find(step => step.id === stepId).attempts.at(-1);

async function fixture(t, count = 1) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'coolbears-deployment-journal-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'deployment');
  const owner = Keypair.generate();
  const builders = [];
  const steps = Array.from({ length: count }, (_, index) => {
    const asset = Keypair.generate();
    const build = (recentBlockhash = blockhash(90 + index), lamports = 12345) => {
      const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash,
        instructions: [SystemProgram.createAccount({ fromPubkey: owner.publicKey,
          newAccountPubkey: asset.publicKey, lamports, space: 0, programId: SystemProgram.programId })],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([asset]);
      return transaction;
    };
    builders.push(build);
    const transaction = build();
    // The immutable manifest is unsigned; a request adds only the disposable
    // asset signature before asking its owner to sign the same message.
    transaction.signatures.forEach(signature => signature.fill(0));
    return { id: `step-${index + 1}`, dependsOn: index ? [`step-${index}`] : [],
      transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
      messageSha256: hash(transaction.message.serialize()), blockhash: transaction.message.recentBlockhash,
      lastValidBlockHeight: 500, requiredSigners: transaction.message.staticAccountKeys.slice(0, 2).map(key => key.toBase58()),
      expected: { kind: 'synthetic-create-account', address: asset.publicKey.toBase58(), lamports: 12345 } };
  });
  const manifest = { version: 1, id: 'deployment-fixture', cluster: 'devnet', owner: owner.publicKey.toBase58(), steps };
  await createDeploymentJournal(directory, manifest);
  return { directory, owner, manifest, builders };
}

function requestFor(h, snapshot, index = 0, transaction = null) {
  const step = h.manifest.steps[index];
  return createSigningRequest({ deploymentId: h.manifest.id, stepId: step.id,
    attempt: snapshot.steps[index].attempts.length + 1, cluster: h.manifest.cluster, owner: h.manifest.owner,
    transactionBase64: Buffer.from((transaction ?? h.builders[index]()).serialize()).toString('base64'),
    lastValidBlockHeight: transaction ? 700 : step.lastValidBlockHeight });
}
async function append(h, type, payload = {}) {
  const snapshot = await readDeploymentJournal(h.directory);
  const stepId = payload.stepId ?? h.manifest.steps[0].id;
  return appendDeploymentEvent(h.directory, { type, stepId, attempt: last(snapshot, stepId)?.number, ...payload }, { expectedRevision: snapshot.revision });
}
async function prepare(h, index = 0, options = {}) {
  const snapshot = await readDeploymentJournal(h.directory);
  const request = requestFor(h, snapshot, index, options.transaction);
  await appendDeploymentEvent(h.directory, { type: 'prepare', stepId: h.manifest.steps[index].id, request,
    retry: options.retry === true }, { expectedRevision: snapshot.revision });
  return request;
}
async function signed(h, request) {
  const transaction = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
  transaction.sign([h.owner]);
  return append(h, 'signed', { stepId: request.stepId, attempt: request.attempt,
    transactionBase64: Buffer.from(transaction.serialize()).toString('base64') });
}
function proof(snapshot, kind, stepId = snapshot.manifest.steps[0].id) {
  const attempt = last(snapshot, stepId), step = snapshot.manifest.steps.find(item => item.id === stepId);
  const common = { kind, manifestSha256: snapshot.manifestSha256, stepId, attempt: attempt.number,
    messageSha256: attempt.request.messageSha256, signature: attempt.signed?.signature ?? null,
    commitment: 'finalized', slot: 100, readSlot: 101, expectedSha256: sha256Json(step.expected) };
  if (kind === 'verified') return { ...common, transactionSucceeded: true, expectedStateVerified: true };
  if (kind === 'failed') return { ...common, executionFailed: true, effectsAbsent: true };
  return { ...common, blockhashValid: false, blockHeight: attempt.request.lastValidBlockHeight + 1,
    signatureAbsent: true, effectsAbsent: true, addressHistoryChecked: true };
}
async function eventFiles(directory) {
  const folder = path.join(directory, 'events');
  const names = (await readdir(folder)).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => ({ name, filename: path.join(folder, name), bytes: await readFile(path.join(folder, name)) })));
}

test('creates a new private journal once, without replacing an existing deployment', async t => {
  const h = await fixture(t, 2);
  const snapshot = await readDeploymentJournal(h.directory);
  assert.deepEqual(snapshot.manifest, h.manifest);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.steps.length, 2);
  assert.ok(snapshot.steps.every(step => step.attempts.length === 0));
  assert.match(snapshot.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(h.directory, 'manifest.json'))).mode & 0o777, 0o600);
  await assert.rejects(createDeploymentJournal(h.directory, h.manifest));
  assert.deepEqual(await readDeploymentJournal(h.directory), snapshot);
});

test('signed bytes and send claim survive reload, requiring reconciliation before another action', async t => {
  const h = await fixture(t), request = await prepare(h);
  await signed(h, request);
  const beforeClaim = await eventFiles(h.directory);
  await append(h, 'claim-send');
  const loaded = await readDeploymentJournal(h.directory);
  assert.equal(last(loaded).state, 'send-claimed');
  assert.ok(last(loaded).signed.signature);
  assert.equal(nextDeploymentAction(loaded).type, 'reconcile');
  await assert.rejects(append(h, 'claim-send'));
  await assert.rejects(prepare(h));
  const afterClaim = await eventFiles(h.directory);
  assert.equal(afterClaim.length, beforeClaim.length + 1);
  for (const file of beforeClaim) assert.deepEqual(await readFile(file.filename), file.bytes, 'Appending never overwrites prior event bytes');
  await append(h, 'reconcile', { proof: proof(loaded, 'verified') });
  assert.equal(nextDeploymentAction(await readDeploymentJournal(h.directory)).type, 'complete');
});

test('acceptance records an RPC reply but does not verify deployment effects', async t => {
  const h = await fixture(t), request = await prepare(h);
  await signed(h, request); await append(h, 'claim-send'); await append(h, 'accepted');
  const loaded = await readDeploymentJournal(h.directory);
  assert.equal(nextDeploymentAction(loaded).type, 'reconcile');
  await assert.rejects(append(h, 'claim-send'));
});

test('finalized receipt needs expected effects; failed retry needs execution failure and absence', async t => {
  const h = await fixture(t), request = await prepare(h);
  await signed(h, request); await append(h, 'claim-send'); await append(h, 'unknown');
  const snapshot = await readDeploymentJournal(h.directory);
  const success = proof(snapshot, 'verified');
  for (const change of [{ transactionSucceeded: false }, { expectedStateVerified: false }, { loaded: true }]) {
    await assert.rejects(append(h, 'reconcile', { proof: { ...success, ...change } }));
  }
  const failed = proof(snapshot, 'failed');
  for (const change of [{ executionFailed: false }, { effectsAbsent: false }, { commitment: 'confirmed' }]) {
    await assert.rejects(append(h, 'reconcile', { proof: { ...failed, ...change } }));
  }
  assert.equal((await readDeploymentJournal(h.directory)).revision, snapshot.revision);
  await append(h, 'reconcile', { proof: failed });
  await assert.rejects(prepare(h));
  await prepare(h, 0, { retry: true, transaction: h.builders[0](blockhash(121)) });
  const reloaded = await readDeploymentJournal(h.directory);
  assert.equal(reloaded.steps[0].attempts[0].state, 'failed');
  assert.equal(reloaded.steps[0].attempts.length, 2);
});

test('stale revisions and concurrent writers cannot append two conflicting first attempts', async t => {
  const h = await fixture(t), initial = await readDeploymentJournal(h.directory);
  const request = requestFor(h, initial);
  const event = { type: 'prepare', stepId: h.manifest.steps[0].id, request, retry: false };
  const outcomes = await Promise.allSettled([
    appendDeploymentEvent(h.directory, event, { expectedRevision: 0 }),
    appendDeploymentEvent(h.directory, event, { expectedRevision: 0 }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const loaded = await readDeploymentJournal(h.directory);
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.steps[0].attempts.length, 1);
  await assert.rejects(appendDeploymentEvent(h.directory, { type: 'unknown', stepId: event.stepId, attempt: 1 }, { expectedRevision: 0 }));
  assert.equal((await readDeploymentJournal(h.directory)).revision, 1);
});

test('an existing writer lock remains blocked and is never stolen automatically', async t => {
  const h = await fixture(t), initial = await readDeploymentJournal(h.directory);
  const lock = path.join(h.directory, '.writer-lock');
  await mkdir(lock, { mode: 0o700 });
  const marker = path.join(lock, 'owner.json');
  const bytes = '{"owner":"previous-process","createdAt":"2000-01-01T00:00:00Z"}\n';
  await writeFile(marker, bytes, { mode: 0o600 });
  const event = { type: 'prepare', stepId: h.manifest.steps[0].id, request: requestFor(h, initial), retry: false };
  await assert.rejects(appendDeploymentEvent(h.directory, event, { expectedRevision: 0 }), /JOURNAL_LOCKED/);
  assert.equal(await readFile(marker, 'utf8'), bytes);
  assert.equal((await readDeploymentJournal(h.directory)).revision, 0);
});

test('unknown stays unknown after a late valid wallet signature and cannot resend', async t => {
  const h = await fixture(t), request = await prepare(h);
  await append(h, 'unknown'); await signed(h, request);
  const loaded = await readDeploymentJournal(h.directory);
  assert.equal(last(loaded).state, 'unknown');
  assert.ok(last(loaded).signed.signature);
  assert.equal(nextDeploymentAction(loaded).type, 'reconcile');
  await assert.rejects(append(h, 'claim-send'));
});

test('dependencies require verified effects and verified steps cannot be restarted', async t => {
  const h = await fixture(t, 2);
  await assert.rejects(prepare(h, 1));
  const request = await prepare(h); await signed(h, request); await append(h, 'claim-send');
  await assert.rejects(prepare(h, 1));
  const snapshot = await readDeploymentJournal(h.directory);
  await append(h, 'reconcile', { proof: proof(snapshot, 'verified') });
  await assert.rejects(prepare(h, 0, { retry: true }));
  await prepare(h, 1);
  const loaded = await readDeploymentJournal(h.directory);
  assert.equal(last(loaded, h.manifest.steps[0].id).state, 'verified');
  assert.equal(loaded.steps[1].attempts.length, 1);
});

test('expiry requires scoped finalized absence proof and explicit retry preserves history', async t => {
  const h = await fixture(t); await prepare(h); await append(h, 'unknown');
  const snapshot = await readDeploymentJournal(h.directory), valid = proof(snapshot, 'expired');
  for (const change of [
    { commitment: 'confirmed' }, { readSlot: 99 }, { blockHeight: 500 },
    { blockhashValid: true }, { signatureAbsent: false }, { effectsAbsent: false }, { addressHistoryChecked: false },
    { manifestSha256: 'b'.repeat(64) }, { expectedSha256: 'b'.repeat(64) }, { messageSha256: 'b'.repeat(64) },
    { stepId: 'other-step' }, { attempt: 2 },
  ]) await assert.rejects(append(h, 'reconcile', { proof: { ...valid, ...change } }));
  assert.equal((await readDeploymentJournal(h.directory)).revision, snapshot.revision);
  await append(h, 'reconcile', { proof: valid });
  const oldEvents = await eventFiles(h.directory);
  await assert.rejects(prepare(h));
  const refreshed = h.builders[0](blockhash(120));
  await prepare(h, 0, { retry: true, transaction: refreshed });
  const retried = await readDeploymentJournal(h.directory);
  assert.equal(retried.steps[0].attempts.length, 2);
  assert.equal(retried.steps[0].attempts[0].state, 'expired');
  assert.equal(last(retried).request.blockhash, blockhash(120));
  for (const file of oldEvents) assert.deepEqual(await readFile(file.filename), file.bytes);
});

test('wallet cancellation needs explicit retry, while changed transaction intent is rejected', async t => {
  const h = await fixture(t); await prepare(h); await append(h, 'cancelled');
  const cancelled = await readDeploymentJournal(h.directory);
  assert.equal(nextDeploymentAction(cancelled).type, 'retry-review');
  await assert.rejects(prepare(h));
  await assert.rejects(prepare(h, 0, { retry: true, transaction: h.builders[0](blockhash(120), 99999) }));
  assert.equal((await readDeploymentJournal(h.directory)).revision, cancelled.revision);
  await prepare(h, 0, { retry: true, transaction: h.builders[0](blockhash(120)) });
  await assert.rejects(append(h, 'unknown', { attempt: 1 }));
});

test('invalid owner signature or changed signed message never reaches a sendable state', async t => {
  const h = await fixture(t), request = await prepare(h);
  const baseline = await readDeploymentJournal(h.directory);
  await assert.rejects(append(h, 'signed', { transactionBase64: request.transactionBase64 }));
  const changed = h.builders[0](request.blockhash, 99999); changed.sign([h.owner]);
  await assert.rejects(append(h, 'signed', { transactionBase64: Buffer.from(changed.serialize()).toString('base64') }));
  const corrupted = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
  corrupted.sign([h.owner]); corrupted.signatures[0][0] ^= 1;
  await assert.rejects(append(h, 'signed', { transactionBase64: Buffer.from(corrupted.serialize()).toString('base64') }));
  assert.deepEqual(await readDeploymentJournal(h.directory), baseline);
});

test('hash-chain corruption and missing event files fail closed', async t => {
  const h = await fixture(t); await prepare(h); await append(h, 'unknown');
  const files = await eventFiles(h.directory);
  assert.ok(files.length >= 2);
  const target = files[0];
  try {
    const altered = JSON.parse(target.bytes); altered.injected = 'untrusted mutation';
    await writeFile(target.filename, JSON.stringify(altered));
    await assert.rejects(readDeploymentJournal(h.directory));
  } finally { await writeFile(target.filename, target.bytes); }
  await unlink(target.filename);
  await assert.rejects(readDeploymentJournal(h.directory));
});

test('truncated event data or a changed manifest cannot be mistaken for an empty/new journal', async t => {
  const h = await fixture(t); await prepare(h);
  const files = await eventFiles(h.directory), target = files[0];
  try {
    await writeFile(target.filename, '{truncated');
    await assert.rejects(readDeploymentJournal(h.directory));
  } finally { await writeFile(target.filename, target.bytes); }
  const filename = path.join(h.directory, 'manifest.json');
  const original = await readFile(filename, 'utf8');
  const changed = JSON.parse(original); changed.injected = 'changed manifest';
  await writeFile(filename, JSON.stringify(changed));
  await assert.rejects(readDeploymentJournal(h.directory));
});
