// A read-only projection of a validated bundle snapshot. Never an executor or
// independent chain proof: every listed action must recheck its own bindings.
import { nextDeploymentAction } from './journal.mjs';
import { readDeploymentBundle } from './vault-store.mjs';

export const queueBinding = snapshot => ({ deploymentId: snapshot.manifest.id,
  manifestSha256: snapshot.manifestSha256, expectedRevision: snapshot.revision,
  expectedHeadHash: snapshot.headHash });

export function deploymentQueueStatus(snapshot) {
  if (snapshot.manifest.cluster !== 'devnet') throw Error('DEVNET_ONLY');
  const next = nextDeploymentAction(snapshot);
  const index = snapshot.steps.findIndex(step => step.id === next.stepId);
  const attempt = snapshot.steps[index]?.attempts.at(-1);
  const verifiedSteps = snapshot.steps.filter(step => step.attempts.at(-1)?.state === 'verified').length;
  let action;
  if (next.type === 'complete') action = 'complete';
  else if (next.type === 'prepare') action = 'prepare';
  else if (next.type === 'retry-review') action = 'manual-retry';
  else if (attempt.state === 'wallet-pending' && !attempt.walletClaim) action = 'sign';
  else if (!attempt.signed) action = 'recover-wallet-response';
  else if (attempt.state === 'signed') action = 'send-once';
  else action = 'reconcile';
  const owner = 'operator/deployment/owner-console/cli.mjs';
  const sender = 'operator/deployment/send-cli.mjs';
  // Argument arrays only, not shell strings. <bundle> is replaced locally by
  // the operator. No path, endpoint, credential, request bytes or key material.
  const command = (script, ...args) => ({ script, args });
  const commands = action === 'prepare' ? [command(owner, 'prepare', '<bundle>', next.stepId)]
    : action === 'manual-retry' ? [command(owner, 'prepare-retry', '<bundle>', next.stepId)]
    : ['sign', 'recover-wallet-response'].includes(action) ? [command(owner, 'serve', '<bundle>')]
    : action === 'send-once' ? [command(sender, 'send-one', '<bundle>', next.stepId, '--devnet-send')]
    : action === 'reconcile' ? [command(sender, 'resume', '<bundle>', next.stepId)] : [];
  return { mode: 'offline-deployment-queue', ...queueBinding(snapshot), cluster: 'devnet',
    progress: { totalSteps: snapshot.steps.length, verifiedSteps,
      remainingSteps: snapshot.steps.length - verifiedSteps, currentStepNumber: index < 0 ? null : index + 1 },
    next: { action, stepId: next.stepId ?? null, attempt: attempt?.number ?? null,
      ...(attempt?.groupId ? { groupId: attempt.groupId } : {}),
      state: attempt?.state ?? (action === 'complete' ? 'complete' : 'unprepared'),
      walletResponseMissing: action === 'recover-wallet-response', commands },
    freshChainCheck: false, readyToSubmit: false, readyToOpenSales: false, salesOpen: false,
    automaticRetry: false, networkRequests: 0, journalWrites: 0, transactionsSent: 0 };
}

export async function readDeploymentQueue(directory) {
  return deploymentQueueStatus((await readDeploymentBundle(directory)).snapshot);
}
