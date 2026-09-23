// Explicit single-step Devnet submission and read-only recovery with CAS writes.
// No wallet, vault unlock, new signature, blockhash replacement or automatic retry.
import { readDeploymentBundle } from './vault-store.mjs';
import { createHash } from 'node:crypto';
import { appendDeploymentEvent, nextDeploymentAction } from './journal.mjs';
import { verifySigningResponse } from './signing.mjs';
import { createDeploymentRpc, assertCluster, DeploymentRpcError } from './rpc.mjs';
import { simulateDeploymentStep } from './simulation.mjs';
import { reconcileDeploymentStep, reconcileFailedDeploymentStep, reconcileExpiredDeploymentStep, assertJournalUnchanged, requireDeploymentCheck as need } from './read.mjs';
import { EXPIRY_FIELDS, validExpiryEvidence } from './expiry.mjs';

const binding = snapshot => ({ manifestSha256: snapshot.manifestSha256, revision: snapshot.revision, headHash: snapshot.headHash });
const attemptAt = (snapshot, stepId) => snapshot.steps.find(step => step.id === stepId)?.attempts.at(-1);
const fixed = { salesOpen: false, readyToOpenSales: false, automaticRetry: false };
const failureCode = error => error instanceof DeploymentRpcError ? `RPC_${error.code}`
  : ['JOURNAL_CHANGED_DURING_READ', 'SAVED_SIGNED_ATTEMPT_REQUIRED', 'STEP_NOT_CURRENT',
    'DEVNET_ONLY', 'EXPLICIT_SEND_REQUIRED', 'SIGNED_SIMULATION_REQUIRED', 'SIMULATION_TOO_OLD',
    'RECONCILIATION_REQUIRED', 'EXPLICIT_RETRY_REVIEW_REQUIRED', 'GATEWAY_RETRY_NOT_AUTHORIZED'].includes(error?.checkCode) ? error.checkCode : 'DEPLOYMENT_SEND_STOPPED';

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

// Explicit review only: never signs or broadcasts. Lost server/disk replies
// are recovered by repeating this review against the same current attempt.
export async function reviewFailedDeploymentStep({ directory, stepId, authorizeRetryReview = false,
  endpoint, fetchImpl, timeoutMs } = {}) {
  let report, rpc;
  try {
    need(authorizeRetryReview === true, 'EXPLICIT_RETRY_REVIEW_REQUIRED');
    const bundle = await readDeploymentBundle(directory), baseline = bundle.snapshot;
    need(baseline.manifest.cluster === 'devnet', 'DEVNET_ONLY');
    const attempt = attemptAt(baseline, stepId);
    if (attempt?.state === 'failed') return { status: 'already-recorded', ...binding(baseline), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, networkRequests: 0, journalWrites: 0, freshChainCheck: false,
      nextAction: 'manual-retry-prepare' };
    need(nextDeploymentAction(baseline).stepId === stepId
      && ['signed', 'send-claimed', 'accepted', 'unknown'].includes(attempt?.state) && attempt.signed, 'RECONCILIATION_REQUIRED');
    const signed = verifySigningResponse(attempt.request, { transactionBase64: attempt.signed.transactionBase64 });
    report = await reconcileFailedDeploymentStep({ directory: bundle.journalDirectory, stepId, endpoint, fetchImpl, timeoutMs });
    if (report.status !== 'failed-verified') return { ...report, ...fixed, submissionAttempts: 0, nextAction: 'reconcile' };
    need(report.manifestSha256 === baseline.manifestSha256 && report.expectedRevision === baseline.revision
      && report.expectedHeadHash === baseline.headHash, 'JOURNAL_CHANGED_DURING_READ');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000, maxResponseBytes: 4096,
      failedRetry: { transactionBase64: signed.transactionBase64 } });
    await assertCluster(rpc, 'devnet');
    const authorization = await rpc.call('coolbears_authorizeFailedRetry', [signed.transactionBase64]);
    need(authorization && Object.keys(authorization).sort().join(',') === 'cluster,signature,slot,status,transactionSha256'
      && authorization.status === 'retry-authorized' && authorization.cluster === 'devnet'
      && authorization.signature === signed.signature && authorization.slot === report.proof.slot
      && authorization.transactionSha256 === createHash('sha256').update(Buffer.from(signed.transactionBase64, 'base64')).digest('hex'),
    'GATEWAY_RETRY_NOT_AUTHORIZED');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    const saved = await appendDeploymentEvent(bundle.journalDirectory, { type: 'reconcile', stepId,
      attempt: attempt.number, proof: report.proof }, { expectedRevision: baseline.revision });
    return { status: 'failed', stepId, attempt: attempt.number, ...binding(saved), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, chainVerified: true, gatewayRetryAuthorized: true,
      networkRequests: report.networkRequests + rpc.requests, journalWrites: 1, nextAction: 'manual-retry-prepare' };
  } catch (error) {
    return { status: 'unknown', code: failureCode(error), ...fixed, submissionAttempts: 0, transactionsSent: 0,
      chainVerified: false, networkRequests: (report?.networkRequests ?? 0) + (rpc?.requests ?? 0),
      nextAction: 'review-same-attempt' };
  }
}

export async function reviewExpiredDeploymentStep({ directory, stepId, authorizeRetryReview = false,
  endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, report;
  try {
    need(authorizeRetryReview === true, 'EXPLICIT_RETRY_REVIEW_REQUIRED');
    const bundle = await readDeploymentBundle(directory), baseline = bundle.snapshot;
    need(baseline.manifest.cluster === 'devnet', 'DEVNET_ONLY');
    const attempt = attemptAt(baseline, stepId);
    if (attempt?.state === 'expired') return { status: 'already-recorded', ...binding(baseline), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, networkRequests: 0, journalWrites: 0, freshChainCheck: false,
      nextAction: 'manual-retry-prepare' };
    need(nextDeploymentAction(baseline).stepId === stepId
      && ['signed', 'send-claimed', 'accepted', 'unknown'].includes(attempt?.state) && attempt.signed, 'RECONCILIATION_REQUIRED');
    const signed = verifySigningResponse(attempt.request, { transactionBase64: attempt.signed.transactionBase64 });
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000, maxResponseBytes: 4096,
      expiredRetry: { transactionBase64: signed.transactionBase64 } });
    await assertCluster(rpc, 'devnet');
    const authorization = await rpc.call('coolbears_authorizeExpiredRetry', [signed.transactionBase64]);
    need(authorization && Object.keys(authorization).sort().join(',') === [...EXPIRY_FIELDS,
      'status', 'kind', 'cluster', 'signature', 'transactionSha256'].sort().join(',')
      && authorization.status === 'retry-authorized' && authorization.kind === 'expired' && authorization.cluster === 'devnet'
      && authorization.signature === signed.signature && validExpiryEvidence(authorization)
      && authorization.transactionSha256 === createHash('sha256').update(Buffer.from(signed.transactionBase64, 'base64')).digest('hex'),
    'GATEWAY_RETRY_NOT_AUTHORIZED');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    report = await reconcileExpiredDeploymentStep({ directory: bundle.journalDirectory, stepId, endpoint, fetchImpl, timeoutMs, evidence: authorization });
    if (report.status !== 'expired-verified') return { ...report, ...fixed, submissionAttempts: 0,
      networkRequests: rpc.requests + report.networkRequests, nextAction: 'review-same-attempt' };
    need(report.manifestSha256 === baseline.manifestSha256 && report.expectedRevision === baseline.revision
      && report.expectedHeadHash === baseline.headHash, 'JOURNAL_CHANGED_DURING_READ');
    await assertJournalUnchanged(bundle.journalDirectory, baseline);
    const saved = await appendDeploymentEvent(bundle.journalDirectory, { type: 'reconcile', stepId,
      attempt: attempt.number, proof: report.proof }, { expectedRevision: baseline.revision });
    return { status: 'expired', stepId, attempt: attempt.number, ...binding(saved), ...fixed,
      submissionAttempts: 0, transactionsSent: 0, chainVerified: true, gatewayRetryAuthorized: true,
      networkRequests: rpc.requests + report.networkRequests, journalWrites: 1, nextAction: 'manual-retry-prepare' };
  } catch (error) {
    return { status: 'unknown', code: failureCode(error), ...fixed, submissionAttempts: 0, transactionsSent: 0,
      chainVerified: false, networkRequests: (rpc?.requests ?? 0) + (report?.networkRequests ?? 0), nextAction: 'review-same-attempt' };
  }
}
