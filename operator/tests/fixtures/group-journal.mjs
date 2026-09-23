// Synthetic finalized prefix only, for offline tests. No actual chain proof.
import { VersionedTransaction } from '@solana/web3.js';
import { openDeploymentSignerVault } from '../../deployment/vault.mjs';
import { appendDeploymentEvent, readDeploymentJournal, sha256Json } from '../../deployment/journal.mjs';
export function fixtureProof(snapshot, index, kind = 'verified') {
  const definition = snapshot.manifest.steps[index], attempt = snapshot.steps[index].attempts.at(-1);
  return { kind, manifestSha256: snapshot.manifestSha256, stepId: definition.id, attempt: attempt.number,
    messageSha256: attempt.request.messageSha256, signature: attempt.signed?.signature ?? null,
    commitment: 'finalized', slot: 500, readSlot: 600, expectedSha256: sha256Json(definition.expected),
    ...(kind === 'verified' ? { transactionSucceeded: true, expectedStateVerified: true }
      : kind === 'failed' ? { executionFailed: true, effectsAbsent: true }
        : { blockhashValid: false, blockHeight: attempt.request.lastValidBlockHeight + 1,
          signatureAbsent: true, effectsAbsent: true, addressHistoryChecked: true }) };
}
export async function seedVerifiedPrefix({ fixture, passphrase, owner, journalDirectory }) {
  const signer = await openDeploymentSignerVault({ ...fixture, passphrase });
  try {
    for (const [index, step] of fixture.manifest.steps.slice(0, 3).entries()) {
      let saved = await readDeploymentJournal(journalDirectory);
      const request = signer.partialSign({ stepId: step.id, transactionBase64: step.transactionBase64,
        lastValidBlockHeight: step.lastValidBlockHeight, attempt: 1 });
      saved = await appendDeploymentEvent(journalDirectory, { type: 'prepare', stepId: step.id, request, retry: false }, { expectedRevision: saved.revision });
      const tx = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64')); tx.sign([owner]);
      saved = await appendDeploymentEvent(journalDirectory, { type: 'signed', stepId: step.id, attempt: 1,
        transactionBase64: Buffer.from(tx.serialize()).toString('base64') }, { expectedRevision: saved.revision });
      await appendDeploymentEvent(journalDirectory, { type: 'reconcile', stepId: step.id, attempt: 1,
        proof: fixtureProof(saved, index) }, { expectedRevision: saved.revision });
    }
  } finally { signer.dispose(); }
}
