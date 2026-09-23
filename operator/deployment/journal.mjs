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
import { validateSigningGroup, signingGroupId, verifySigningGroupResponse } from './group-signing.mjs';

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
  const pending = snapshot.steps.find(step => last(step)?.state !== 'verified');
  if (!pending) return { type: 'complete', readyToOpenSales: false };
  if (ACTIVE.has(last(pending)?.state)) return { type: 'reconcile', stepId: pending.id, attempt: last(pending).number };
  return { type: last(pending) ? 'retry-review' : 'prepare', stepId: pending.id };
}

function preparedAttempt(snapshot, step, definition, request) {
  const expected = createSigningRequest({ deploymentId: snapshot.manifest.id, stepId: step.id,
    attempt: step.attempts.length + 1, cluster: snapshot.manifest.cluster, owner: snapshot.manifest.owner,
    transactionBase64: request?.transactionBase64, lastValidBlockHeight: request?.lastValidBlockHeight });
  assert.deepEqual(request, expected, 'REQUEST_BINDING_MISMATCH');
  requireThat(!step.attempts.some(previous => previous.signed && previous.request.blockhash === request.blockhash), 'RETRY_REQUIRES_NEW_BLOCKHASH');
  const template = decode(definition.transactionBase64), prepared = decode(request.transactionBase64);
  prepared.message.recentBlockhash = template.message.recentBlockhash;
  requireThat(Buffer.from(prepared.message.serialize()).equals(Buffer.from(template.message.serialize())), 'REQUEST_INTENT_MISMATCH');
  return { number: expected.attempt, state: 'wallet-pending', request: structuredClone(request), signed: null, proof: null };
}

export function deploymentGroupAttempts(snapshot, groupId) {
  requireThat(typeof groupId === 'string' && /^[a-f0-9]{64}$/.test(groupId), 'INVALID_GROUP_ID');
  const entries = snapshot.steps.flatMap(step => step.attempts.filter(attempt => attempt.groupId === groupId)
    .map(attempt => ({ step, attempt })));
  requireThat(signingGroupId(entries.map(entry => entry.attempt.request)) === groupId, 'GROUP_BINDING_MISMATCH');
  return entries;
}

function applyGroupEvent(snapshot, event) {
  if (event.type === 'prepare-group') {
    exact(event, 'type stepId groupId requests');
    const requests = validateSigningGroup(event.requests), action = nextDeploymentAction(snapshot);
    requireThat(snapshot.manifest.cluster === 'devnet' && action.type === 'prepare' && action.stepId === event.stepId
      && requests[0].stepId === event.stepId && signingGroupId(requests) === event.groupId, 'GROUP_NOT_READY');
    const index = snapshot.steps.findIndex(step => step.id === event.stepId);
    requireThat(index >= 3, 'GROUP_INSERT_ONLY');
    const prepared = requests.map((request, offset) => {
      const step = snapshot.steps[index + offset], definition = snapshot.manifest.steps[index + offset];
      requireThat(step && step.id === request.stepId && step.attempts.length === 0
        && definition.requiredSigners.length === 1 && definition.expected.configLines?.length > 0, 'GROUP_NOT_READY');
      return { ...preparedAttempt(snapshot, step, definition, request), groupId: event.groupId };
    });
    for (const [offset, attempt] of prepared.entries()) snapshot.steps[index + offset].attempts.push(attempt);
  } else {
    const signed = event.type === 'signed-group';
    exact(event, `type stepId groupId ${signed ? 'transactionBase64s' : 'claimId'}`);
    const entries = deploymentGroupAttempts(snapshot, event.groupId);
    requireThat(entries[0].step.id === event.stepId && entries.every(({ step, attempt }) => last(step) === attempt), 'GROUP_CHANGED');
    requireThat(nextDeploymentAction(snapshot).stepId === event.stepId, 'GROUP_NOT_CURRENT');
    if (signed) {
      const verified = verifySigningGroupResponse(entries.map(x => x.attempt.request), event.transactionBase64s);
      requireThat(entries.every(x => ['wallet-pending', 'unknown'].includes(x.attempt.state)
        && !x.attempt.signed && x.attempt.walletClaim === entries[0].attempt.walletClaim)
        && !!entries[0].attempt.walletClaim, 'GROUP_SIGNATURE_NOT_EXPECTED');
      entries.forEach(({ attempt }, i) => { attempt.signed = verified[i]; if (attempt.state !== 'unknown') attempt.state = 'signed'; });
    } else {
      requireThat(typeof event.claimId === 'string' && /^[a-f0-9]{64}$/.test(event.claimId)
        && entries.every(x => x.attempt.state === 'wallet-pending' && !x.attempt.signed), 'GROUP_WALLET_NOT_READY');
      const requesting = event.type === 'request-wallet-group';
      requireThat(entries.every(x => requesting ? !x.attempt.walletClaim : x.attempt.walletClaim === event.claimId), 'GROUP_CLAIM_MISMATCH');
      entries.forEach(({ attempt }) => { attempt.walletClaim = requesting ? event.claimId : null; });
    }
  }
  snapshot.revision++;
  return snapshot;
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
  if (['prepare-group', 'request-wallet-group', 'wallet-declined-group', 'signed-group'].includes(event.type)) return applyGroupEvent(next, event);
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
    step.attempts.push(preparedAttempt(next, step, definition, event.request));
  } else {
    const fields = { 'request-wallet': 'claimId', 'wallet-declined': 'claimId', signed: 'transactionBase64', 'claim-send': '', accepted: '', unknown: '', cancelled: '', reconcile: 'proof' };
    requireThat(Object.hasOwn(fields, event.type), 'UNKNOWN_EVENT');
    exact(event, `type stepId attempt${fields[event.type] ? ` ${fields[event.type]}` : ''}`);
    requireThat(attempt && event.attempt === attempt.number, 'STALE_ATTEMPT');
    requireThat(ACTIVE.has(attempt.state), 'ATTEMPT_TERMINAL');
    if (attempt.groupId) requireThat(!['request-wallet', 'wallet-declined', 'signed', 'cancelled'].includes(event.type), 'GROUP_EVENT_REQUIRED');
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
        requireThat(nextDeploymentAction(next).stepId === step.id, 'STEP_NOT_CURRENT');
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
