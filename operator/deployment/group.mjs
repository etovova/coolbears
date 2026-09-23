// Small insertion-only groups. No key unlock, wallet invocation or submission.
import { VersionedTransaction } from '@solana/web3.js';
import { readDeploymentBundle } from './vault-store.mjs';
import { validateCanonicalDeploymentManifest } from './intent.mjs';
import { nextDeploymentAction, appendDeploymentEvent, deploymentGroupAttempts } from './journal.mjs';
import { createScopedDeploymentRpc } from './scoped-rpc.mjs';
import { assertCluster } from './rpc.mjs';
import { checkDeploymentState, assertJournalUnchanged, rpcContext, rpcAmount } from './read.mjs';
import { createSigningRequest } from './signing.mjs';
import { MAX_SIGNING_GROUP, signingGroupId } from './group-signing.mjs';
const need = ok => { if (!ok) throw Error('GROUP_CHECK_BLOCKED'); };

export async function checkDeploymentGroup({ directory, count, groupId, endpoint, fetchImpl, timeoutMs } = {}) {
  try {
    const { snapshot, journalDirectory } = await readDeploymentBundle(directory);
    const plan = await validateCanonicalDeploymentManifest(snapshot.manifest);
    need(plan.cluster === 'devnet');
    const action = nextDeploymentAction(snapshot), index = snapshot.steps.findIndex(step => step.id === action.stepId);
    let requests;
    if (groupId !== undefined) {
      const entries = deploymentGroupAttempts(snapshot, groupId);
      need(count === undefined && entries[0].step.id === action.stepId && entries.every(({ step, attempt }) =>
        step.attempts.at(-1) === attempt && attempt.state === 'wallet-pending' && !attempt.walletClaim && !attempt.signed));
      requests = entries.map(x => x.attempt.request); count = requests.length;
    } else {
      need(action.type === 'prepare' && Number.isInteger(count) && count >= 2 && count <= MAX_SIGNING_GROUP);
    }
    need(index >= 3 && index + count <= plan.steps.length);
    const steps = plan.steps.slice(index, index + count);
    need(steps.every((step, offset) => step.kind === 'insert' && step.requiredSigners.length === 1
      && step.requiredSigners[0] === plan.roles.owner && (groupId !== undefined || snapshot.steps[index + offset].attempts.length === 0)));
    const rpc = await createScopedDeploymentRpc({ manifest: snapshot.manifest, endpoint, fetchImpl, timeoutMs,
      totalTimeoutMs: 30000, allowSimulation: true });
    const started = performance.now();
    await assertCluster(rpc, 'devnet');
    let slot = await checkDeploymentState(rpc, plan, index - 1);
    const balance = await rpc.call('getBalance', [plan.roles.owner, { commitment: 'finalized', minContextSlot: slot }]);
    slot = rpcContext(balance, slot); const funds = rpcAmount(balance.value);
    if (!requests) {
      const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: slot }]);
      slot = rpcContext(latest, slot);
      requests = steps.map(step => {
        const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
        tx.message.recentBlockhash = latest.value.blockhash;
        return createSigningRequest({ deploymentId: snapshot.manifest.id, stepId: step.id, attempt: 1,
          cluster: 'devnet', owner: plan.roles.owner, transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
          lastValidBlockHeight: latest.value.lastValidBlockHeight });
      });
    }
    const id = signingGroupId(requests);
    need(groupId === undefined || groupId === id);
    let totalFees = 0n;
    // addConfigLines addresses explicit unused ranges. Simulate each against
    // the same verified prefix, not fictitious future accounts or state overrides.
    for (const request of requests) {
      const tx = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
      const fee = await rpc.call('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'),
        { commitment: 'confirmed', minContextSlot: slot }]);
      slot = rpcContext(fee, slot); const amount = rpcAmount(fee.value); need(amount > 0n); totalFees += amount;
      const simulation = await rpc.call('simulateTransaction', [request.transactionBase64, { encoding: 'base64',
        commitment: 'confirmed', minContextSlot: slot, sigVerify: false, replaceRecentBlockhash: false }]);
      slot = rpcContext(simulation, slot);
      need(simulation.value?.err === null && simulation.value.replacementBlockhash == null
        && Number.isSafeInteger(simulation.value.unitsConsumed) && simulation.value.unitsConsumed >= 0);
    }
    need(funds >= totalFees);
    const valid = await rpc.call('isBlockhashValid', [requests[0].blockhash, { commitment: 'confirmed', minContextSlot: slot }]);
    slot = rpcContext(valid, slot); need(valid.value === true);
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: slot }]);
    need(Number.isSafeInteger(height) && height >= 0 && requests[0].lastValidBlockHeight - height >= 80);
    // minContextSlot cannot force a finalized bank to overtake a confirmed bank.
    // Recheck the whole finalized prefix without substituting a later fake slot.
    await checkDeploymentState(rpc, plan, index - 1, balance.context.slot);
    await assertJournalUnchanged(journalDirectory, snapshot);
    need(performance.now() - started <= 30000);
    return { snapshot, journalDirectory, requests, groupId: id, checkedSlot: slot,
      networkRequests: rpc.requests, totalFeesLamports: totalFees.toString(), simulationVerified: true };
  } catch { throw Object.assign(Error('Group preflight did not pass.'), { code: 'PREFLIGHT_BLOCKED' }); }
}

export async function prepareDeploymentGroup(options) {
  const checked = await checkDeploymentGroup(options);
  const stepId = checked.requests[0].stepId;
  const saved = await appendDeploymentEvent(checked.journalDirectory, { type: 'prepare-group', stepId,
    groupId: checked.groupId, requests: checked.requests }, { expectedRevision: checked.snapshot.revision });
  need(deploymentGroupAttempts(saved, checked.groupId).length === checked.requests.length);
  return { status: 'group-saved', groupId: checked.groupId, stepId, count: checked.requests.length,
    revision: saved.revision, headHash: saved.headHash, simulationVerified: true,
    estimatedGroupFeesLamports: checked.totalFeesLamports, networkRequests: checked.networkRequests,
    budgetComplete: false, ownerSignatureCreated: false, transactionsSent: 0, salesOpen: false };
}
