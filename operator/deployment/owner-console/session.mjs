// One existing durable request per local session. No new keys or broadcast path.
import { readDeploymentBundle } from '../vault-store.mjs';
import { randomBytes } from 'node:crypto';
import { nextDeploymentAction, sha256Json, appendDeploymentEvent } from '../journal.mjs';
import { simulateDeploymentStep } from '../simulation.mjs';
import { acceptDeploymentSigningResponse } from '../handoff.mjs';
import { validateSigningRequest, verifySigningResponse } from '../signing.mjs';
import { deploymentQueueStatus } from '../queue.mjs';
import { createGroupSigningSession } from './group-session.mjs';
const need = (value, code) => { if (!value) throw Object.assign(Error('Signing session unavailable.'), { code }); };
export async function createSigningSession({ directory, endpoint, fetchImpl, timeoutMs } = {}) {
  const first = await readDeploymentBundle(directory), snapshot = first.snapshot;
  need(snapshot.manifest.cluster === 'devnet', 'CLUSTER');
  const action = nextDeploymentAction(snapshot);
  const initial = snapshot.steps.find(step => step.id === action.stepId)?.attempts.at(-1);
  if (initial?.groupId) return createGroupSigningSession({ directory, groupId: initial.groupId, endpoint, fetchImpl, timeoutMs });
  need(initial && ['wallet-pending', 'signed', 'unknown'].includes(initial.state), 'NO_PENDING_REQUEST');
  const request = structuredClone(initial.request);
  validateSigningRequest(request);
  const requestId = sha256Json(request), manifestSha256 = snapshot.manifestSha256;
  let busy = false;
  async function current() {
    const bundle = await readDeploymentBundle(directory), saved = bundle.snapshot;
    const attempt = saved.steps.find(step => step.id === request.stepId)?.attempts.at(-1);
    need(saved.manifestSha256 === manifestSha256 && attempt?.number === request.attempt
      && sha256Json(attempt.request) === requestId, 'REQUEST_CHANGED');
    return { snapshot: saved, attempt, journalDirectory: bundle.journalDirectory };
  }
  const stateOf = (attempt, saved) => ({ requestId, manifestSha256, deploymentId: request.deploymentId,
    stepId: request.stepId, attempt: request.attempt, owner: request.owner, cluster: 'devnet',
    messageSha256: request.messageSha256, state: attempt.state, signed: !!attempt.signed, walletRequested: !!attempt.walletClaim,
    ...(attempt.signed ? { signature: attempt.signed.signature } : {}),
    progress: deploymentQueueStatus(saved).progress,
    readyToSubmit: false, salesOpen: false, transactionsSent: 0 });
  return Object.freeze({
    async state() { const value = await current(); return stateOf(value.attempt, value.snapshot); },
    async check(id) {
      need(id === requestId, 'REQUEST_CHANGED'); need(!busy, 'BUSY'); busy = true;
      try {
        const before = await current();
        need(before.attempt.state === 'wallet-pending' && !before.attempt.signed && !before.attempt.walletClaim, 'ALREADY_HANDLED');
        const report = await simulateDeploymentStep({ directory: before.journalDirectory, stepId: request.stepId,
          mode: 'unsigned', endpoint, fetchImpl, timeoutMs });
        need(report.status === 'simulation-passed' && report.mode === 'unsigned' && report.cluster === 'devnet'
          && report.manifestSha256 === manifestSha256 && report.expectedRevision === before.snapshot.revision
          && report.expectedHeadHash === before.snapshot.headHash && report.candidate?.transactionBase64 === request.transactionBase64,
        'PREFLIGHT_BLOCKED');
        const after = await current();
        need(after.snapshot.revision === before.snapshot.revision && after.snapshot.headHash === before.snapshot.headHash, 'REQUEST_CHANGED');
        const claimId = randomBytes(32).toString('hex');
        const saved = await appendDeploymentEvent(after.journalDirectory,
          { type: 'request-wallet', stepId: request.stepId, attempt: request.attempt, claimId }, { expectedRevision: after.snapshot.revision });
        const claimed = saved.steps.find(step => step.id === request.stepId).attempts.at(-1);
        need(claimed.walletClaim === claimId, 'SAVE_UNCONFIRMED');
        return { ...stateOf(claimed, saved), claimId, request: structuredClone(request), simulationVerified: true,
          checkedSlot: report.checkedSlot, expiresAt: Date.now() + 20000 };
      } finally { busy = false; }
    },
    async decline(id, claimId) {
      need(id === requestId && typeof claimId === 'string', 'REQUEST_CHANGED'); need(!busy, 'BUSY'); busy = true;
      try {
        const before = await current();
        need(before.attempt.state === 'wallet-pending' && !before.attempt.signed && before.attempt.walletClaim === claimId, 'ALREADY_HANDLED');
        await appendDeploymentEvent(before.journalDirectory,
          { type: 'wallet-declined', stepId: request.stepId, attempt: request.attempt, claimId }, { expectedRevision: before.snapshot.revision });
        const value = await current();
        return { ...stateOf(value.attempt, value.snapshot), status: 'declined' };
      } finally { busy = false; }
    },
    async accept(id, transactionBase64) {
      need(id === requestId, 'REQUEST_CHANGED'); need(!busy, 'BUSY'); busy = true;
      try {
        const before = await current();
        verifySigningResponse(request, { transactionBase64 });
        // A lost HTTP acknowledgment must never require another wallet signature.
        if (before.attempt.signed) {
          need(before.attempt.signed.transactionBase64 === transactionBase64, 'SIGNED_BYTES_CHANGED');
          return { ...stateOf(before.attempt, before.snapshot), status: 'saved', alreadySaved: true };
        }
        need(['wallet-pending', 'unknown'].includes(before.attempt.state), 'ALREADY_HANDLED');
        await acceptDeploymentSigningResponse({ directory, request, response: { transactionBase64 } });
        const value = await current();
        return { ...stateOf(value.attempt, value.snapshot), status: 'saved', alreadySaved: false };
      } finally { busy = false; }
    },
  });
}
