// Explicit single-step Devnet submission and read-only recovery with CAS writes.
// No wallet, vault unlock, new signature, blockhash replacement or automatic retry.
import { readDeploymentBundle } from './vault-store.mjs';
import { appendDeploymentEvent, nextDeploymentAction } from './journal.mjs';
import { verifySigningResponse } from './signing.mjs';
import { createDeploymentRpc, assertCluster, DeploymentRpcError } from './rpc.mjs';
import { simulateDeploymentStep } from './simulation.mjs';
import { reconcileDeploymentStep, assertJournalUnchanged, requireDeploymentCheck as need } from './read.mjs';

const binding = snapshot => ({ manifestSha256: snapshot.manifestSha256, revision: snapshot.revision, headHash: snapshot.headHash });
const attemptAt = (snapshot, stepId) => snapshot.steps.find(step => step.id === stepId)?.attempts.at(-1);
const fixed = { salesOpen: false, readyToOpenSales: false, automaticRetry: false };
const failureCode = error => error instanceof DeploymentRpcError ? `RPC_${error.code}`
  : ['JOURNAL_CHANGED_DURING_READ', 'SAVED_SIGNED_ATTEMPT_REQUIRED', 'STEP_NOT_CURRENT',
    'DEVNET_ONLY', 'EXPLICIT_SEND_REQUIRED', 'SIGNED_SIMULATION_REQUIRED', 'SIMULATION_TOO_OLD',
    'RECONCILIATION_REQUIRED'].includes(error?.checkCode) ? error.checkCode : 'DEPLOYMENT_SEND_STOPPED';

export async function sendDeploymentStep({ directory, stepId, authorizeDevnetSend = false,
  endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, priorRequests = 0, claimStarted = false, claimed = null, submissionAttempts = 0;
  try {
    need(authorizeDevnetSend === true, 'EXPLICIT_SEND_REQUIRED');
    const bundle = await readDeploymentBundle(directory), baseline = bundle.snapshot;
    need(baseline.manifest.cluster === 'devnet', 'DEVNET_ONLY');
    const action = nextDeploymentAction(baseline), attempt = attemptAt(baseline, stepId);
    need(action.stepId === stepId, 'STEP_NOT_CURRENT');
    need(attempt?.state === 'signed' && attempt.signed, 'SAVED_SIGNED_ATTEMPT_REQUIRED');
    const signed = verifySigningResponse(attempt.request, { transactionBase64: attempt.signed.transactionBase64 });
    const startedAt = performance.now();
    const check = await simulateDeploymentStep({ directory: bundle.journalDirectory, stepId, mode: 'signed', endpoint, fetchImpl, timeoutMs });
    priorRequests = check.networkRequests;
    if (check.status !== 'simulation-passed') return { ...check, ...fixed, submissionAttempts: 0 };
    need(check.mode === 'signed' && check.signaturesVerified === true && check.simulationVerified === true
      && check.candidate.transactionBase64 === signed.transactionBase64
      && check.manifestSha256 === baseline.manifestSha256 && check.expectedRevision === baseline.revision
      && check.expectedHeadHash === baseline.headHash, 'SIGNED_SIMULATION_REQUIRED');
    // The transport is bound to exactly these wire bytes and this minimum slot.
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, maxResponseBytes: 16384,
      submission: { transactionBase64: signed.transactionBase64, minContextSlot: check.checkedSlot } });
    await assertCluster(rpc, 'devnet');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    need(performance.now() - startedAt <= 30000, 'SIMULATION_TOO_OLD');
    claimStarted = true;
    claimed = await appendDeploymentEvent(bundle.journalDirectory, { type: 'claim-send', stepId, attempt: attempt.number },
      { expectedRevision: baseline.revision });
    await assertJournalUnchanged(bundle.journalDirectory, claimed);
    need(performance.now() - startedAt <= 30000, 'SIMULATION_TOO_OLD');
    submissionAttempts = 1;
    await rpc.call('sendTransaction', [signed.transactionBase64, { encoding: 'base64', skipPreflight: false,
      preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: check.checkedSlot }]);
    const saved = await appendDeploymentEvent(bundle.journalDirectory, { type: 'accepted', stepId, attempt: attempt.number },
      { expectedRevision: claimed.revision });
    return { status: 'accepted', stepId, attempt: attempt.number, signature: signed.signature,
      ...binding(saved), ...fixed, submissionAttempts, transactionsSent: null, chainVerified: false,
      networkRequests: priorRequests + rpc.requests, nextAction: 'reconcile' };
  } catch (error) {
    // A failed publication may already have committed. Do not release the claim,
    // downgrade it to "not sent", or write a new attempt to hide uncertainty.
    return { status: claimStarted ? 'unknown' : 'blocked', code: failureCode(error), ...fixed,
      submissionAttempts, transactionsSent: submissionAttempts ? null : 0, chainVerified: false,
      networkRequests: priorRequests + (rpc?.requests ?? 0), nextAction: claimStarted ? 'reconcile' : 'review' };
  }
}

export async function resumeDeploymentStep({ directory, stepId, endpoint, fetchImpl, timeoutMs } = {}) {
  let report;
  try {
    const bundle = await readDeploymentBundle(directory), baseline = bundle.snapshot;
    need(baseline.manifest.cluster === 'devnet', 'DEVNET_ONLY');
    const attempt = attemptAt(baseline, stepId);
    if (attempt?.state === 'verified') return { status: 'already-recorded', ...binding(baseline), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, networkRequests: 0, journalWrites: 0, freshChainCheck: false };
    need(['signed', 'send-claimed', 'accepted', 'unknown'].includes(attempt?.state) && attempt.signed, 'RECONCILIATION_REQUIRED');
    report = await reconcileDeploymentStep({ directory: bundle.journalDirectory, stepId, endpoint, fetchImpl, timeoutMs });
    if (report.status !== 'verified') return { ...report, ...fixed, submissionAttempts: 0, nextAction: 'reconcile' };
    need(report.manifestSha256 === baseline.manifestSha256 && report.expectedRevision === baseline.revision
      && report.expectedHeadHash === baseline.headHash, 'JOURNAL_CHANGED_DURING_READ');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    const saved = await appendDeploymentEvent(bundle.journalDirectory, { type: 'reconcile', stepId,
      attempt: attempt.number, proof: report.proof }, { expectedRevision: baseline.revision });
    return { status: 'verified', stepId, attempt: attempt.number, ...binding(saved), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, chainVerified: true, networkRequests: report.networkRequests,
      journalWrites: 1, nextAction: nextDeploymentAction(saved).type };
  } catch (error) {
    return { status: 'unknown', code: failureCode(error), ...fixed, submissionAttempts: 0, transactionsSent: 0,
      chainVerified: false, networkRequests: report?.networkRequests ?? 0, nextAction: 'reconcile' };
  }
}
