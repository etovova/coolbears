import { randomBytes } from 'node:crypto';
import { readDeploymentBundle } from '../vault-store.mjs';
import { deploymentGroupAttempts, appendDeploymentEvent } from '../journal.mjs';
import { deploymentQueueStatus } from '../queue.mjs';
import { checkDeploymentGroup } from '../group.mjs';
import { verifySigningGroupResponse } from '../group-signing.mjs';
import { networkProfile } from '../network.mjs';
const need = (ok, code = 'REQUEST_CHANGED') => { if (!ok) throw Object.assign(Error('Group unavailable.'), { code }); };
export async function createGroupSigningSession({ directory, groupId, endpoint, fetchImpl, timeoutMs, authorizeMainnetSigning = false }) {
  const initial = await readDeploymentBundle(directory);
  const profile = networkProfile(initial.snapshot.manifest.cluster);
  need(typeof authorizeMainnetSigning === 'boolean'
    && authorizeMainnetSigning === (profile.cluster === 'mainnet-beta'), 'MAINNET_SIGN_AUTHORIZATION');
  const entries = deploymentGroupAttempts(initial.snapshot, groupId), requests = entries.map(x => x.attempt.request);
  need(requests.every(request => request.cluster === profile.cluster && request.deploymentId === initial.snapshot.manifest.id
    && request.owner === initial.snapshot.manifest.owner));
  const first = requests[0], manifestSha256 = initial.snapshot.manifestSha256;
  let busy = false;
  async function current() {
    const bundle = await readDeploymentBundle(directory);
    need(bundle.snapshot.manifestSha256 === manifestSha256 && bundle.snapshot.manifest.cluster === profile.cluster);
    return { ...bundle, entries: deploymentGroupAttempts(bundle.snapshot, groupId) };
  }
  function view(value) {
    const allSigned = value.entries.every(x => !!x.attempt.signed), queue = deploymentQueueStatus(value.snapshot);
    const currentMember = value.entries.find(x => x.step.id === queue.next.stepId);
    return { requestId: groupId, groupId, groupSize: requests.length, manifestSha256,
      deploymentId: first.deploymentId, stepId: first.stepId, attempt: 1, owner: first.owner, cluster: profile.cluster, walletChain: profile.walletChain,
      messageSha256: groupId, state: currentMember?.attempt.state ?? (value.entries.every(x => x.attempt.state === 'verified') ? 'verified' : 'signed'),
      signed: allSigned, walletRequested: value.entries.some(x => !!x.attempt.walletClaim),
      groupStates: value.entries.map(x => ({ stepId: x.step.id, state: x.attempt.state })),
      progress: queue.progress, readyToSubmit: false, salesOpen: false, transactionsSent: 0 };
  }
  return Object.freeze({
    async state() { return view(await current()); },
    async check(id) {
      need(id === groupId); need(!busy, 'BUSY'); busy = true;
      try {
        const checked = await checkDeploymentGroup({ directory, groupId, endpoint, fetchImpl, timeoutMs,
          authorizeMainnet: authorizeMainnetSigning });
        need(checked.snapshot.manifestSha256 === manifestSha256 && checked.snapshot.manifest.cluster === profile.cluster
          && (profile.cluster !== 'mainnet-beta' || checked.cluster === profile.cluster && checked.genesisHash === profile.genesisHash)
          && checked.requests.every((request, index) => JSON.stringify(request) === JSON.stringify(requests[index])));
        const claimId = randomBytes(32).toString('hex');
        await appendDeploymentEvent(checked.journalDirectory, { type: 'request-wallet-group', stepId: first.stepId, groupId, claimId },
          { expectedRevision: checked.snapshot.revision });
        return { ...view(await current()), requests: structuredClone(requests), claimId,
          simulationVerified: true, checkedSlot: checked.checkedSlot, expiresAt: Date.now() + 20000 };
      } finally { busy = false; }
    },
    async decline(id, claimId) {
      need(id === groupId); need(!busy, 'BUSY'); busy = true;
      try {
        const value = await current();
        await appendDeploymentEvent(value.journalDirectory, { type: 'wallet-declined-group', stepId: first.stepId, groupId, claimId },
          { expectedRevision: value.snapshot.revision });
        return { ...view(await current()), status: 'declined' };
      } finally { busy = false; }
    },
    async accept(id, transactionBase64s) {
      need(id === groupId); need(!busy, 'BUSY'); busy = true;
      try {
        verifySigningGroupResponse(requests, transactionBase64s);
        const value = await current();
        if (value.entries.every(x => !!x.attempt.signed)) {
          need(value.entries.every((x, i) => x.attempt.signed.transactionBase64 === transactionBase64s[i]), 'SIGNED_BYTES_CHANGED');
          return { ...view(value), status: 'saved', alreadySaved: true };
        }
        await appendDeploymentEvent(value.journalDirectory, { type: 'signed-group', stepId: first.stepId, groupId, transactionBase64s },
          { expectedRevision: value.snapshot.revision });
        return { ...view(await current()), status: 'saved', alreadySaved: false };
      } finally { busy = false; }
    },
  });
}
