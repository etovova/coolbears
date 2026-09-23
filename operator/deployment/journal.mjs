// Offline deployment journal. No wallet, RPC, signing or submission capability.
// The caller supplies a trusted, policy-reviewed plan; normalized finalized
// receipts are the trusted read adapter's responsibility, not authenticated here.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, link, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { VersionedTransaction } from '@solana/web3.js';
import { createSigningRequest, verifySigningResponse } from './signing.mjs';

const ACTIVE = new Set(['wallet-pending', 'signed', 'send-claimed', 'accepted', 'unknown']);
const RETRYABLE = new Set(['cancelled', 'failed', 'expired']);
const requireThat = (value, message) => { if (!value) throw Error(message); };
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const last = step => step.attempts.at(-1);
function exact(value, fields) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_RECORD');
  try { assert.deepEqual(Object.keys(value).sort(), fields.split(' ').sort()); }
  catch { throw Error('UNEXPECTED_FIELDS'); }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const messageHash = tx => createHash('sha256').update(tx.message.serialize()).digest('hex');

function decode(base64) {
  try {
    requireThat(typeof base64 === 'string', 'INVALID_TRANSACTION');
    const bytes = Buffer.from(base64, 'base64');
    requireThat(bytes.length > 0 && bytes.length <= 1232 && bytes.toString('base64') === base64, 'INVALID_TRANSACTION');
    const tx = VersionedTransaction.deserialize(bytes);
    requireThat(Buffer.from(tx.serialize()).equals(bytes), 'NONCANONICAL_TRANSACTION');
    requireThat(!tx.message.addressTableLookups?.length, 'LOOKUP_TABLES_UNSUPPORTED');
    return tx;
  } catch { throw Error('INVALID_TRANSACTION'); }
}

function validateManifest(manifest) {
  exact(manifest, 'version id cluster owner steps');
  try { assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest); }
  catch { throw Error('MANIFEST_MUST_BE_JSON'); }
  requireThat(manifest.version === 1 && id(manifest.id) && ['devnet', 'mainnet-beta'].includes(manifest.cluster), 'INVALID_MANIFEST');
  requireThat(Array.isArray(manifest.steps) && manifest.steps.length > 0 && manifest.steps.length <= 20000, 'INVALID_STEPS');
  const seen = new Set();
  for (const [index, step] of manifest.steps.entries()) {
    exact(step, 'id dependsOn transactionBase64 messageSha256 blockhash lastValidBlockHeight requiredSigners expected');
    requireThat(id(step.id) && !seen.has(step.id), 'INVALID_STEP_ID');
    // A linear dependency chain deliberately prevents parallel transaction runs.
    assert.deepEqual(step.dependsOn, index ? [manifest.steps[index - 1].id] : [], 'INVALID_DEPENDENCIES');
    seen.add(step.id);
    const tx = decode(step.transactionBase64);
    requireThat(tx.signatures.every(signature => !signature.some(Boolean)), 'TEMPLATE_MUST_BE_UNSIGNED');
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(key => key.toBase58());
    requireThat(signers.length > 0 && signers[0] === manifest.owner, 'WRONG_OWNER');
    assert.deepEqual(signers, step.requiredSigners, 'WRONG_SIGNERS');
    requireThat(step.messageSha256 === messageHash(tx) && step.blockhash === tx.message.recentBlockhash && integer(step.lastValidBlockHeight, 1), 'INVALID_TEMPLATE_BINDING');
    requireThat(step.expected && typeof step.expected === 'object' && !Array.isArray(step.expected), 'INVALID_EXPECTED_STATE');
  }
  return manifest;
}

export function nextDeploymentAction(snapshot) {
  const active = snapshot.steps.find(step => ACTIVE.has(last(step)?.state));
  if (active) return { type: 'reconcile', stepId: active.id, attempt: last(active).number };
  const pending = snapshot.steps.find(step => last(step)?.state !== 'verified');
  if (!pending) return { type: 'complete', readyToOpenSales: false };
  return { type: last(pending) ? 'retry-review' : 'prepare', stepId: pending.id };
}

function validateProof(snapshot, definition, attempt, proof) {
  const extras = {
    verified: 'transactionSucceeded expectedStateVerified',
    failed: 'executionFailed effectsAbsent',
    expired: 'blockhashValid blockHeight signatureAbsent effectsAbsent addressHistoryChecked',
  }[proof?.kind];
  requireThat(extras, 'INVALID_PROOF');
  exact(proof, `kind manifestSha256 stepId attempt messageSha256 signature commitment slot readSlot expectedSha256 ${extras}`);
  requireThat(proof.manifestSha256 === snapshot.manifestSha256 && proof.stepId === definition.id && proof.attempt === attempt.number, 'PROOF_SCOPE_MISMATCH');
  requireThat(proof.messageSha256 === attempt.request.messageSha256 && proof.expectedSha256 === sha256Json(definition.expected), 'PROOF_INTENT_MISMATCH');
  requireThat(proof.signature === (attempt.signed?.signature ?? null), 'PROOF_SIGNATURE_MISMATCH');
  requireThat(proof.commitment === 'finalized' && integer(proof.slot) && integer(proof.readSlot) && proof.readSlot >= proof.slot, 'PROOF_NOT_FINALIZED');
  if (proof.kind === 'verified') {
    requireThat(attempt.signed && proof.transactionSucceeded === true && proof.expectedStateVerified === true, 'SUCCESS_NOT_PROVEN');
  } else if (proof.kind === 'failed') {
    requireThat(attempt.signed && proof.executionFailed === true && proof.effectsAbsent === true, 'FAILURE_NOT_PROVEN');
  } else {
    requireThat(proof.blockhashValid === false && integer(proof.blockHeight) && proof.blockHeight > attempt.request.lastValidBlockHeight, 'EXPIRY_NOT_PROVEN');
    requireThat(proof.signatureAbsent === true && proof.effectsAbsent === true && proof.addressHistoryChecked === true, 'ABSENCE_NOT_PROVEN');
  }
}

function applyEvent(snapshot, event) {
  // Replay owns this object; avoid cloning the full 9,999-line plan per event.
  const next = snapshot;
  requireThat(event && id(event.stepId), 'INVALID_EVENT');
  const step = next.steps.find(value => value.id === event.stepId);
  const definition = next.manifest.steps.find(value => value.id === event.stepId);
  requireThat(step && definition, 'UNKNOWN_STEP');
  let attempt = last(step);
  if (event.type === 'prepare') {
    exact(event, 'type stepId request retry');
    requireThat(typeof event.retry === 'boolean', 'EXPLICIT_RETRY_REQUIRED');
    const action = nextDeploymentAction(next);
    requireThat(['prepare', 'retry-review'].includes(action.type) && action.stepId === step.id, 'STEP_NOT_READY');
    if (attempt) requireThat(event.retry === true && RETRYABLE.has(attempt.state), 'EXPLICIT_RETRY_REQUIRED');
    const request = event.request;
    // Re-derive all fields; requests are trusted only when also bound to this manifest.
    const expectedRequest = createSigningRequest({ deploymentId: next.manifest.id, stepId: step.id,
      attempt: step.attempts.length + 1, cluster: next.manifest.cluster, owner: next.manifest.owner,
      transactionBase64: request?.transactionBase64, lastValidBlockHeight: request?.lastValidBlockHeight });
    assert.deepEqual(request, expectedRequest, 'REQUEST_BINDING_MISMATCH');
    requireThat(!step.attempts.some(previous => previous.signed && previous.request.blockhash === request.blockhash), 'RETRY_REQUIRES_NEW_BLOCKHASH');
    const template = decode(definition.transactionBase64), prepared = decode(request.transactionBase64);
    // A fresh blockhash is required in real execution. It may change; every
    // other message byte (including payer, accounts and instructions) is fixed.
    prepared.message.recentBlockhash = template.message.recentBlockhash;
    requireThat(Buffer.from(prepared.message.serialize()).equals(Buffer.from(template.message.serialize())), 'REQUEST_INTENT_MISMATCH');
    step.attempts.push({ number: expectedRequest.attempt, state: 'wallet-pending', request: structuredClone(request), signed: null, proof: null });
  } else {
    const fields = { 'request-wallet': 'claimId', 'wallet-declined': 'claimId', signed: 'transactionBase64', 'claim-send': '', accepted: '', unknown: '', cancelled: '', reconcile: 'proof' };
    requireThat(Object.hasOwn(fields, event.type), 'UNKNOWN_EVENT');
    exact(event, `type stepId attempt${fields[event.type] ? ` ${fields[event.type]}` : ''}`);
    requireThat(attempt && event.attempt === attempt.number, 'STALE_ATTEMPT');
    requireThat(ACTIVE.has(attempt.state), 'ATTEMPT_TERMINAL');
    switch (event.type) {
      case 'request-wallet':
        requireThat(attempt.state === 'wallet-pending' && !attempt.signed && !attempt.walletClaim
          && typeof event.claimId === 'string' && /^[0-9a-f]{64}$/.test(event.claimId), 'WALLET_ALREADY_REQUESTED');
        attempt.walletClaim = event.claimId; break;
      case 'wallet-declined':
        // A trusted local UI reported explicit code 4001. This is not a chain
        // failure/expiry proof and cannot release an uncertain or signed attempt.
        requireThat(attempt.state === 'wallet-pending' && !attempt.signed && attempt.walletClaim
          && event.claimId === attempt.walletClaim, 'WALLET_DECLINE_MISMATCH');
        attempt.walletClaim = null; break;
      case 'signed': {
        requireThat(['wallet-pending', 'unknown'].includes(attempt.state), 'SIGNATURE_NOT_EXPECTED');
        const signed = verifySigningResponse(attempt.request, { transactionBase64: event.transactionBase64 });
        if (attempt.signed) assert.deepEqual(signed, attempt.signed, 'SIGNATURE_CONFLICT');
        attempt.signed = signed;
        if (attempt.state === 'wallet-pending') attempt.state = 'signed';
        break;
      }
      case 'claim-send':
        requireThat(attempt.state === 'signed', 'SEND_NOT_ALLOWED');
        attempt.state = 'send-claimed'; break;
      case 'accepted':
        requireThat(attempt.state === 'send-claimed', 'ACCEPTANCE_NOT_EXPECTED');
        attempt.state = 'accepted'; break;
      case 'unknown': attempt.state = 'unknown'; break;
      case 'cancelled':
        requireThat(attempt.state === 'wallet-pending' && !attempt.signed && !attempt.walletClaim, 'CANCELLATION_NOT_PROVEN');
        attempt.state = 'cancelled'; break;
      case 'reconcile':
        validateProof(next, definition, attempt, event.proof);
        attempt.proof = structuredClone(event.proof); attempt.state = event.proof.kind; break;
    }
  }
  next.revision++;
  return next;
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readJson(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'INVALID_JOURNAL_FILE');
    return JSON.parse(await handle.readFile('utf8'));
  } catch { throw Error('CORRUPT_JOURNAL_FILE'); }
  finally { await handle.close(); }
}
async function publishImmutable(directory, filename, value) {
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  // link() publishes a complete file and refuses to replace an existing name.
  // An interrupted temporary file is retained for diagnosis, never replayed.
  await link(temporary, path.join(directory, filename));
  await syncDirectory(directory);
  await unlink(temporary);
  await syncDirectory(directory);
}

export async function createDeploymentJournal(directory, manifest) {
  validateManifest(manifest);
  const root = path.resolve(directory);
  await mkdir(root, { mode: 0o700 });
  await publishImmutable(root, 'manifest.json', manifest);
  await mkdir(path.join(root, 'events'), { mode: 0o700 });
  await syncDirectory(root);
  await syncDirectory(path.dirname(root));
  return readDeploymentJournal(root);
}

export async function readDeploymentJournal(directory) {
  const root = path.resolve(directory);
  const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')));
  const manifestSha256 = sha256Json(manifest);
  let snapshot = { manifest, manifestSha256, revision: 0, headHash: manifestSha256,
    steps: manifest.steps.map(step => ({ id: step.id, attempts: [] })) };
  const entries = await readdir(path.join(root, 'events'));
  requireThat(entries.every(name => /^\d{8}\.json$/.test(name) || /^\.pending-[0-9a-f-]{36}$/.test(name)), 'UNEXPECTED_JOURNAL_FILE');
  const files = entries.filter(name => /^\d{8}\.json$/.test(name)).sort();
  for (const [index, filename] of files.entries()) {
    requireThat(filename === `${String(index + 1).padStart(8, '0')}.json`, 'JOURNAL_GAP');
    const record = await readJson(path.join(root, 'events', filename));
    exact(record, 'version seq manifestSha256 previousHash event eventHash');
    const { eventHash, ...payload } = record;
    requireThat(record.version === 1 && record.seq === snapshot.revision + 1 && record.manifestSha256 === manifestSha256 && record.previousHash === snapshot.headHash && eventHash === sha256Json(payload), 'JOURNAL_CHAIN_MISMATCH');
    snapshot = applyEvent(snapshot, record.event);
    snapshot.headHash = eventHash;
  }
  return snapshot;
}

export async function appendDeploymentEvent(directory, event, { expectedRevision } = {}) {
  requireThat(integer(expectedRevision), 'EXPECTED_REVISION_REQUIRED');
  const root = path.resolve(directory), lock = path.join(root, '.writer-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('JOURNAL_LOCKED'); throw error; }
  try {
    await syncDirectory(root);
    const current = await readDeploymentJournal(root);
    requireThat(current.revision === expectedRevision, 'STALE_REVISION');
    applyEvent(structuredClone(current), event); // Validate before writing history.
    const payload = { version: 1, seq: current.revision + 1, manifestSha256: current.manifestSha256, previousHash: current.headHash, event: structuredClone(event) };
    const record = { ...payload, eventHash: sha256Json(payload) };
    await publishImmutable(path.join(root, 'events'), `${String(record.seq).padStart(8, '0')}.json`, record);
    const saved = await readDeploymentJournal(root);
    requireThat(saved.headHash === record.eventHash && saved.revision === record.seq, 'COMMIT_NOT_VERIFIED');
    return saved;
  } finally {
    await rmdir(lock);
    await syncDirectory(root);
  }
}
