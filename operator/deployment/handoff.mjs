// Durable local owner-signing handoff. This does not open a wallet, send a
// transaction, prove settlement, or make the incomplete budget sufficient.
import { readDeploymentBundle } from './vault-store.mjs';
import { openDeploymentSignerVault } from './vault.mjs';
import { simulateDeploymentStep } from './simulation.mjs';
import { readDeploymentJournal, appendDeploymentEvent, nextDeploymentAction, sha256Json } from './journal.mjs';
import { verifySigningResponse } from './signing.mjs';

export class DeploymentHandoffError extends Error {
  constructor(code) { super(`DEPLOYMENT_HANDOFF_${code}`); this.name = 'DeploymentHandoffError'; this.code = `DEPLOYMENT_HANDOFF_${code}`; }
}
const need = (condition, code) => { if (!condition) throw new DeploymentHandoffError(code); };
const limits = () => ({ readyToSubmit: false, budgetComplete: false, simulationVerified: false,
  lifetimeGuaranteed: false, salesOpen: false, transactionsSent: 0 });

function options(input, allowed, required) {
  need(input !== null && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'INVALID_INPUT');
  const fields = Reflect.ownKeys(input);
  need(fields.every(field => typeof field === 'string' && allowed.includes(field)), 'INVALID_INPUT');
  need(required.every(field => fields.includes(field)), 'INVALID_INPUT');
  const copy = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    need(Object.hasOwn(descriptor, 'value'), 'INVALID_INPUT');
    copy[field] = descriptor.value;
  }
  return copy;
}
function safeError(error) {
  if (error instanceof DeploymentHandoffError) return error;
  if (error?.code === 'DEPLOYMENT_VAULT_INVALID') return new DeploymentHandoffError('VAULT_INVALID');
  if (error?.code === 'DEPLOYMENT_SIGNING_INVALID') return new DeploymentHandoffError('SIGNING_RESPONSE_INVALID');
  // Never attach cause, passphrase, endpoint or arbitrary provider/fs text.
  return new DeploymentHandoffError('FAILED');
}
function binding(snapshot, stepId, attempt) {
  return { deploymentId: snapshot.manifest.id, manifestSha256: snapshot.manifestSha256,
    expectedRevision: snapshot.revision, expectedHeadHash: snapshot.headHash, stepId, attempt };
}
function sameSnapshot(current, baseline) {
  need(current.manifestSha256 === baseline.manifestSha256 && current.manifest.id === baseline.manifest.id
    && current.revision === baseline.revision && current.headHash === baseline.headHash, 'JOURNAL_CHANGED');
}
function currentAttempt(snapshot, stepId) {
  return snapshot.steps.find(step => step.id === stepId)?.attempts.at(-1);
}
function sameRequest(left, right) {
  need(left && right && sha256Json(left) === sha256Json(right), 'REQUEST_MISMATCH');
}
function preflightMatches(report, snapshot, stepId) {
  need(report?.status === 'simulation-passed', 'PREFLIGHT_BLOCKED');
  need(report.deploymentId === snapshot.manifest.id && report.manifestSha256 === snapshot.manifestSha256
    && report.expectedRevision === snapshot.revision && report.expectedHeadHash === snapshot.headHash
    && report.stepId === stepId && report.cluster === snapshot.manifest.cluster
    && report.source === 'refreshed-unsigned-template', 'PREFLIGHT_BINDING_MISMATCH');
  need(report.transactionsSent === 0 && report.journalWrites === 0 && report.readyToSubmit === false
    && report.budget?.complete === false && report.simulationVerified === true
    && report.mode === 'unsigned' && report.signaturesVerified === false, 'PREFLIGHT_BINDING_MISMATCH');
}

export async function prepareDeploymentSigning(input) {
  let signer, ownedPassphrase;
  try {
    const args = options(input, ['directory', 'stepId', 'passphrase', 'endpoint', 'fetchImpl', 'timeoutMs', 'retry'],
      ['directory', 'stepId', 'passphrase', 'endpoint']);
    const retry = args.retry ?? false;
    need(typeof retry === 'boolean', 'INVALID_INPUT');
    need(args.passphrase instanceof Uint8Array && args.passphrase.length >= 16 && args.passphrase.length <= 1024, 'INVALID_INPUT');
    ownedPassphrase = new Uint8Array(args.passphrase);
    const bundle = await readDeploymentBundle(args.directory);
    const baseline = bundle.snapshot, action = nextDeploymentAction(baseline);
    need(action.stepId === args.stepId, 'STEP_NOT_CURRENT');
    need(action.type === 'prepare' || action.type === 'retry-review', 'RECONCILIATION_REQUIRED');
    need(action.type !== 'retry-review' || retry, 'EXPLICIT_RETRY_REQUIRED');
    // Authenticate and validate the vault before making any network request.
    signer = await openDeploymentSignerVault({ vault: bundle.vault, manifest: baseline.manifest, passphrase: ownedPassphrase });
    ownedPassphrase.fill(0);
    sameSnapshot(await readDeploymentJournal(bundle.journalDirectory), baseline);
    const preflight = await simulateDeploymentStep({ directory: bundle.journalDirectory, stepId: args.stepId, mode: 'unsigned',
      endpoint: args.endpoint, fetchImpl: args.fetchImpl, timeoutMs: args.timeoutMs });
    preflightMatches(preflight, baseline, args.stepId);
    sameSnapshot(await readDeploymentJournal(bundle.journalDirectory), baseline);
    const attempt = (currentAttempt(baseline, args.stepId)?.number ?? 0) + 1;
    const candidate = preflight.candidate;
    need(!baseline.steps.find(step => step.id === args.stepId).attempts.some(previous =>
      previous.signed && previous.request.blockhash === candidate.blockhash), 'RETRY_REQUIRES_NEW_BLOCKHASH');
    const request = signer.partialSign({ stepId: args.stepId, transactionBase64: candidate.transactionBase64,
      lastValidBlockHeight: candidate.lastValidBlockHeight, attempt });
    need(request.messageSha256 === candidate.messageSha256 && request.blockhash === candidate.blockhash
      && sha256Json(request.requiredSigners) === sha256Json(candidate.requiredSigners), 'PREFLIGHT_BINDING_MISMATCH');
    // Recheck the head as well as revision; append's exclusive lock guards the
    // revision once acquired. This is not protection against a malicious writer.
    sameSnapshot(await readDeploymentJournal(bundle.journalDirectory), baseline);
    const saved = await appendDeploymentEvent(bundle.journalDirectory,
      { type: 'prepare', stepId: args.stepId, request, retry }, { expectedRevision: baseline.revision });
    const recorded = currentAttempt(saved, args.stepId);
    need(saved.manifestSha256 === baseline.manifestSha256 && saved.revision === baseline.revision + 1
      && recorded?.number === attempt && recorded.state === 'wallet-pending', 'SAVE_NOT_VERIFIED');
    sameRequest(recorded.request, request);
    return { request: structuredClone(recorded.request), binding: binding(saved, args.stepId, attempt),
      preflight, ...limits(), simulationVerified: true, simulationMode: 'unsigned' };
  } catch (error) { throw safeError(error); }
  finally { ownedPassphrase?.fill(0); signer?.dispose(); }
}

export async function readPendingDeploymentSigning(directory) {
  try {
    const { snapshot } = await readDeploymentBundle(directory);
    const action = nextDeploymentAction(snapshot);
    const attempt = currentAttempt(snapshot, action.stepId);
    need(action.type === 'reconcile' && attempt?.state === 'wallet-pending', 'RECONCILIATION_REQUIRED');
    return { request: structuredClone(attempt.request), binding: binding(snapshot, action.stepId, attempt.number), ...limits() };
  } catch (error) { throw safeError(error); }
}

export async function acceptDeploymentSigningResponse(input) {
  try {
    const args = options(input, ['directory', 'request', 'response'], ['directory', 'request', 'response']);
    // Own the returned records before asynchronous file reads. No caller object
    // remains live while a verified signature is committed to the journal.
    const request = structuredClone(args.request), response = structuredClone(args.response);
    const bundle = await readDeploymentBundle(args.directory), baseline = bundle.snapshot;
    const action = nextDeploymentAction(baseline), attempt = currentAttempt(baseline, action.stepId);
    need(action.type === 'reconcile' && ['wallet-pending', 'unknown'].includes(attempt?.state), 'RECONCILIATION_REQUIRED');
    need(request?.stepId === action.stepId && request?.attempt === attempt.number, 'REQUEST_MISMATCH');
    sameRequest(request, attempt.request);
    const signed = verifySigningResponse(attempt.request, response);
    sameSnapshot(await readDeploymentJournal(bundle.journalDirectory), baseline);
    const saved = await appendDeploymentEvent(bundle.journalDirectory,
      { type: 'signed', stepId: action.stepId, attempt: attempt.number, transactionBase64: signed.transactionBase64 },
      { expectedRevision: baseline.revision });
    const recorded = currentAttempt(saved, action.stepId);
    need(saved.manifestSha256 === baseline.manifestSha256 && saved.revision === baseline.revision + 1
      && recorded?.number === attempt.number && recorded.state === (attempt.state === 'unknown' ? 'unknown' : 'signed'), 'SAVE_NOT_VERIFIED');
    sameRequest(recorded.request, attempt.request);
    need(sha256Json(recorded.signed) === sha256Json(signed), 'SAVE_NOT_VERIFIED');
    return { signature: recorded.signed.signature, binding: binding(saved, action.stepId, attempt.number),
      state: recorded.state, ...limits() };
  } catch (error) { throw safeError(error); }
}
