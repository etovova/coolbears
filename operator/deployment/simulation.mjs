// Exact-message RPC simulation. No key generation, signing, journal mutation,
// broadcast, automatic retry or blockhash replacement exists in this module.
import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { preflightDeploymentStep, rpcContext, assertJournalUnchanged,
  requireDeploymentCheck as need, blockedDeploymentReport } from './read.mjs';
import { readDeploymentJournal } from './journal.mjs';
import { verifySigningResponse } from './signing.mjs';
import { assertCluster } from './rpc.mjs';
import { createScopedDeploymentRpc } from './scoped-rpc.mjs';

export async function simulateDeploymentStep({ directory, stepId, mode, endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, phase = 'journal', previousRequests = 0;
  try {
    need(['unsigned', 'signed'].includes(mode), 'EXPLICIT_SIMULATION_MODE_REQUIRED');
    const baseline = await readDeploymentJournal(directory);
    const attempt = baseline.steps.find(step => step.id === stepId)?.attempts.at(-1);
    if (mode === 'signed') {
      need(attempt?.state === 'signed' && attempt.signed, 'SAVED_SIGNED_ATTEMPT_REQUIRED');
      verifySigningResponse(attempt.request, { transactionBase64: attempt.signed.transactionBase64 });
    } else need(!attempt?.signed || attempt.state === 'failed', 'UNSIGNED_MODE_HAS_OWNER_SIGNATURE');
    const startedAt = performance.now();
    const preflight = await preflightDeploymentStep({ directory, stepId, endpoint, fetchImpl, timeoutMs });
    previousRequests = preflight.networkRequests;
    if (preflight.status !== 'read-checks-passed') return { ...preflight, mode, simulationVerified: false };
    need(preflight.expectedRevision === baseline.revision && preflight.expectedHeadHash === baseline.headHash
      && preflight.manifestSha256 === baseline.manifestSha256, 'JOURNAL_CHANGED_DURING_READ');
    const candidate = preflight.candidate;
    const bytes = Buffer.from(candidate.transactionBase64, 'base64');
    const tx = VersionedTransaction.deserialize(bytes);
    need(Buffer.from(tx.serialize()).equals(bytes), 'NONCANONICAL_SIMULATION_TRANSACTION');
    if (mode === 'signed') need(candidate.transactionBase64 === attempt.signed.transactionBase64, 'SIGNED_SIMULATION_BYTES_CHANGED');
    else {
      need(tx.signatures[0].every(byte => byte === 0), 'UNSIGNED_MODE_HAS_OWNER_SIGNATURE');
      if (attempt?.state === 'failed') need(preflight.source === 'refreshed-unsigned-template'
        && tx.signatures.every(signature => signature.every(byte => byte === 0)), 'RETRY_TEMPLATE_REQUIRED');
    }
    rpc = await createScopedDeploymentRpc({ manifest: baseline.manifest, endpoint, fetchImpl, timeoutMs,
      totalTimeoutMs: 30000, allowSimulation: true });
    phase = 'network';
    await assertCluster(rpc, preflight.cluster);
    phase = 'simulation';
    const result = await rpc.call('simulateTransaction', [candidate.transactionBase64, {
      encoding: 'base64', commitment: 'confirmed', sigVerify: mode === 'signed',
      replaceRecentBlockhash: false, minContextSlot: preflight.quoteSlot,
    }]);
    const simulationSlot = rpcContext(result, preflight.quoteSlot);
    need(result.value && Object.hasOwn(result.value, 'err'), 'INVALID_SIMULATION_RESULT');
    need(result.value.err === null, 'SIMULATION_EXECUTION_FAILED');
    need(result.value.replacementBlockhash == null, 'SIMULATION_REPLACED_BLOCKHASH');
    need(Number.isSafeInteger(result.value.unitsConsumed) && result.value.unitsConsumed >= 0, 'INVALID_SIMULATION_UNITS');
    phase = 'blockhash';
    const valid = await rpc.call('isBlockhashValid', [candidate.blockhash, { commitment: 'confirmed', minContextSlot: simulationSlot }]);
    const checkedSlot = rpcContext(valid, simulationSlot);
    need(valid.value === true, 'BLOCKHASH_NOT_VALID');
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: checkedSlot }]);
    need(Number.isSafeInteger(height) && height >= 0 && height < candidate.lastValidBlockHeight, 'BLOCK_HEIGHT_NOT_USABLE');
    phase = 'journal';
    await assertJournalUnchanged(directory, baseline);
    need(performance.now() - startedAt <= 30000, 'SIMULATION_TOO_OLD');
    return { ...preflight, status: 'simulation-passed', mode, simulationVerified: true,
      signaturesVerified: mode === 'signed', simulationSlot, checkedSlot, unitsConsumed: result.value.unitsConsumed,
      transactionSha256: createHash('sha256').update(bytes).digest('hex'),
      checkedAt: new Date().toISOString(), networkRequests: previousRequests + rpc.requests,
      budgetComplete: false, readyToSubmit: false, lifetimeGuaranteed: false, salesOpen: false };
  } catch (error) {
    const result = blockedDeploymentReport(error, phase, rpc, 'blocked');
    return { ...result, networkRequests: previousRequests + result.networkRequests, simulationVerified: false };
  }
}
