// Only source/calibration reads use RPC. Every deployment operation is local.
import { setTimeout as sleep } from 'node:timers/promises';
import { VersionedTransaction } from '@solana/web3.js';
import { createDeploymentRpc, assertCluster } from './rpc.mjs';
import { rpcContext, rpcAmount, requireDeploymentCheck as need, blockedDeploymentReport } from './read.mjs';
import { captureIsolatedSnapshot, bytesHash, RENT_SYSVAR } from './isolated-snapshot.mjs';
import { runIsolatedDeployment } from './isolated.mjs';

export async function previewIsolatedDeployment({ endpoint, fetchImpl = (...args) => globalThis.fetch(...args), onProgress = () => {} } = {}) {
  let snapshot, report, rpc, phase = 'configuration', previousStart = -Infinity;
  try {
    need(typeof fetchImpl === 'function' && typeof onProgress === 'function', 'INVALID_ISOLATED_OPTIONS');
    rpc = createDeploymentRpc({ endpoint, maxResponseBytes: 16 * 1024 * 1024,
      timeoutMs: 30000, totalTimeoutMs: 120000,
      fetchImpl: async (url, options) => {
        const delay = Math.max(0, 350 - (performance.now() - previousStart));
        if (delay) await sleep(delay, undefined, { signal: options.signal });
        previousStart = performance.now();
        return fetchImpl(url, options);
      } });
    phase = 'source-snapshot'; snapshot = await captureIsolatedSnapshot(rpc);
    onProgress({ phase, slot: snapshot.accounts.context.slot });
    phase = 'local-execution';
    const result = await runIsolatedDeployment({ snapshot, onProgress });
    report = result.report;
    if (report.status !== 'isolated-passed') return { report, snapshot };
    phase = 'rent-calibration';
    const rentQuotes = [];
    for (const quote of report.localRentQuotes) {
      const lamports = rpcAmount(await rpc.call('getMinimumBalanceForRentExemption', [quote.bytes, { commitment: 'finalized' }]));
      need(lamports.toString() === quote.lamports, 'ISOLATED_LIVE_RENT_MISMATCH');
      rentQuotes.push({ bytes: quote.bytes, lamports: lamports.toString() });
    }
    phase = 'fee-calibration';
    const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: report.sourceSlot }]);
    const slot = rpcContext(latest, report.sourceSlot);
    need(typeof latest.value?.blockhash === 'string' && Number.isSafeInteger(latest.value.lastValidBlockHeight)
      && latest.value.lastValidBlockHeight > 0, 'INVALID_LATEST_BLOCKHASH');
    const feeQuotes = [];
    // Four representative shapes only. PR25 separately quoted all 1431.
    // Do not describe this calibration as a full fresh network budget.
    for (const step of result.plan.steps.slice(0, 4)) {
      const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
      tx.message.recentBlockhash = latest.value.blockhash;
      const message = tx.message.serialize();
      const quoted = await rpc.call('getFeeForMessage', [Buffer.from(message).toString('base64'),
        { commitment: 'confirmed', minContextSlot: slot }]);
      const quoteSlot = rpcContext(quoted, slot), fee = rpcAmount(quoted.value);
      need(fee > 0n && fee.toString() === report.steps.find(x => x.id === step.id).feeLamports, 'ISOLATED_LIVE_FEE_MISMATCH');
      feeQuotes.push({ id: step.id, messageSha256: bytesHash(message), slot: quoteSlot, lamports: fee.toString() });
    }
    const valid = await rpc.call('isBlockhashValid', [latest.value.blockhash, { commitment: 'confirmed', minContextSlot: slot }]);
    rpcContext(valid, slot);
    need(valid.value === true, 'CALIBRATION_BLOCKHASH_EXPIRED');
    phase = 'source-recheck'; await assertCluster(rpc, 'devnet');
    const rentEnd = await rpc.call('getMultipleAccounts', [[RENT_SYSVAR],
      { commitment: 'finalized', encoding: 'base64', minContextSlot: report.sourceSlot }]);
    rpcContext(rentEnd, report.sourceSlot);
    // The sysvar supplying the local rent schedule must stay unchanged.
    need(JSON.stringify(rentEnd.value) === JSON.stringify([snapshot.accounts.value[6]]), 'RENT_CHANGED_DURING_ISOLATED_PREVIEW');
    report.calibration = { cluster: 'devnet', checkedAt: new Date().toISOString(), rentQuotes, feeQuotes,
      representativeMessagesQuoted: feeQuotes.length, everyMessageQuoted: false,
      rentMatched: true, representativeFeesMatched: true, programSnapshotRevalidatedAfterRun: false };
    report.status = 'isolated-passed-and-calibrated';
  } catch (error) {
    const blocked = blockedDeploymentReport(error, phase, rpc, 'blocked');
    report = { ...report, version: 1, kind: 'isolated-devnet-deployment', status: 'blocked',
      phase: blocked.phase, code: blocked.code, salesOpen: false, readyToSubmit: false,
      transactionsSent: 0, realTransactionsSent: 0, realLamportsSpent: '0',
      budgetComplete: false, fundingRecommendationLamports: null };
  } finally {
    if (report) { report.networkRequests = rpc?.requests ?? 0; report.completedAt = new Date().toISOString(); }
  }
  return { report, snapshot };
}
