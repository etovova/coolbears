// Full source-backed deployment estimate with live per-message quotes. This is
// not a funding authorization: deployed program layouts/charges still require
// execution evidence. No signing, journal mutation or transaction submission.
import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { buildDeploymentCostModel } from './cost-model.mjs';
import { readDeploymentJournal } from './journal.mjs';
import { verifySigningResponse } from './signing.mjs';
import { verifyFinalizedReceipt } from './receipt.mjs';
import { assertCluster } from './rpc.mjs';
import { createScopedDeploymentRpc } from './scoped-rpc.mjs';
import { rpcContext, rpcAmount, snapshotBinding, assertJournalUnchanged, checkDeploymentState,
  requireDeploymentCheck as need, blockedDeploymentReport } from './read.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const sum = values => values.reduce((total, value) => total + BigInt(value), 0n);
export const formatSol = lamports => {
  const n = BigInt(lamports);
  return `${n / 1000000000n}.${(n % 1000000000n).toString().padStart(9, '0')}`;
};

// Stop issuing new work after a failure and drain already pending reads before
// returning. No unobserved promises continue to query after a blocked report.
async function mapBounded(values, concurrency, run) {
  let cursor = 0, failure;
  const output = new Array(values.length);
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failure && cursor < values.length) {
      const index = cursor++;
      try { output[index] = await run(values[index], index); } catch (error) { failure ??= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return output;
}

async function spentReceipt(rpc, attempt) {
  const verified = verifySigningResponse(attempt.request, { transactionBase64: attempt.signed.transactionBase64 });
  const statusResult = await rpc.call('getSignatureStatuses', [[verified.signature], { searchTransactionHistory: true }]);
  const tx = await rpc.call('getTransaction', [verified.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  if (attempt.state === 'verified') verifyFinalizedReceipt({ request: attempt.request, signed: attempt.signed, statusResult, transactionResult: tx });
  else {
    // Failed attempts are chargeable too. Null/expired observations cannot
    // prove zero spent, so they are handled as unknown outside this function.
    const statusSlot = rpcContext(statusResult);
    const status = statusResult.value?.[0];
    need(statusResult.value?.length === 1 && status?.confirmationStatus === 'finalized' && status.confirmations === null
      && Number.isSafeInteger(status.slot) && status.slot > 0 && status.slot <= statusSlot
      && status.err != null && tx?.slot === status.slot && tx.version === 0 && tx.meta?.err != null
      && JSON.stringify(status.err) === JSON.stringify(tx.meta.err)
      && tx.transaction?.length === 2 && tx.transaction[0] === verified.transactionBase64 && tx.transaction[1] === 'base64', 'SPENT_RECEIPT_UNVERIFIED');
    if (Object.hasOwn(status, 'status')) need(status.status && Object.keys(status.status).length === 1
      && Object.hasOwn(status.status, 'Err') && JSON.stringify(status.status.Err) === JSON.stringify(status.err), 'SPENT_RECEIPT_UNVERIFIED');
  }
  const wire = VersionedTransaction.deserialize(Buffer.from(verified.transactionBase64, 'base64'));
  const count = wire.message.staticAccountKeys.length;
  need(tx.meta?.preBalances?.length === count && tx.meta?.postBalances?.length === count, 'SPENT_BALANCES_UNAVAILABLE');
  need([...tx.meta.preBalances, ...tx.meta.postBalances].every(value => Number.isSafeInteger(value) && value >= 0), 'SPENT_BALANCES_UNAVAILABLE');
  const fee = rpcAmount(tx.meta.fee);
  need(fee > 0n, 'INVALID_SPENT_FEE');
  const debit = rpcAmount(tx.meta.preBalances[0]) - rpcAmount(tx.meta.postBalances[0]);
  need(debit >= fee && (attempt.state !== 'failed' || debit === fee), 'SPENT_DEBIT_UNVERIFIED');
  return { signature: verified.signature, state: attempt.state, slot: tx.slot,
    networkFeeLamports: fee.toString(), ownerDebitLamports: debit.toString() };
}

export async function quoteDeploymentBudget({ directory, endpoint, fetchImpl, timeoutMs,
  concurrency = 8, bufferBasisPoints = 1000, retryTransactions = 10 } = {}) {
  let rpc, phase = 'journal';
  try {
    need(integer(concurrency, 16) && concurrency >= 1 && integer(bufferBasisPoints, 10000)
      && integer(retryTransactions, 10000), 'INVALID_BUDGET_OPTIONS');
    const baseline = await readDeploymentJournal(directory);
    const { plan, model } = await buildDeploymentCostModel(baseline.manifest);
    const latest = baseline.steps.map(step => step.attempts.at(-1));
    need(!latest.some(attempt => ['send-claimed', 'accepted', 'unknown'].includes(attempt?.state)), 'RECONCILIATION_REQUIRED');
    let completedIndex = -1;
    while (latest[completedIndex + 1]?.state === 'verified') completedIndex++;
    const startedAt = performance.now();
    phase = 'network';
    rpc = await createScopedDeploymentRpc({ manifest: baseline.manifest, endpoint, fetchImpl, timeoutMs,
      totalTimeoutMs: 120000, recoverySignatures: baseline.steps.flatMap(step => step.attempts)
        .filter(attempt => attempt.signed && ['verified', 'failed'].includes(attempt.state))
        .map(attempt => attempt.signed.signature) });
    const genesisHash = await assertCluster(rpc, plan.cluster);
    phase = 'accounts';
    let accountSlot = await checkDeploymentState(rpc, plan, completedIndex);
    phase = 'rent';
    const sizes = [...new Set(Object.values(model.sizes))];
    const rentQuotes = await mapBounded(sizes, concurrency, async bytes => {
      const value = rpcAmount(await rpc.call('getMinimumBalanceForRentExemption', [bytes, { commitment: 'finalized' }]));
      need(value > 0n, 'INVALID_RENT_QUOTE');
      return { bytes, lamports: value.toString() };
    });
    const rentBySize = new Map(rentQuotes.map(quote => [quote.bytes, BigInt(quote.lamports)]));
    if (completedIndex < 2) need(rentBySize.get(plan.machineSpace).toString() === plan.machineRentLamports, 'MACHINE_RENT_CHANGED_REBUILD_PLAN');
    const rentItems = model.rentItems.map(item => {
      const value = rentBySize.get(item.bytes) - (item.subtractBytes ? rentBySize.get(item.subtractBytes) : 0n);
      need(value > 0n, 'INVALID_RENT_GROWTH');
      return { ...item, lamports: value.toString() };
    });
    phase = 'spent';
    const incurred = [], unverifiedSpent = [];
    for (const step of baseline.steps) for (const attempt of step.attempts) {
      if (!attempt.signed) continue;
      if (['verified', 'failed'].includes(attempt.state)) incurred.push({ stepId: step.id, attempt: attempt.number, ...await spentReceipt(rpc, attempt) });
      else if (attempt.state !== 'signed') unverifiedSpent.push({ stepId: step.id, attempt: attempt.number });
    }
    const receiptSlot = incurred.reduce((max, receipt) => Math.max(max, receipt.slot), 0);
    if (receiptSlot > accountSlot) accountSlot = await checkDeploymentState(rpc, plan, completedIndex, receiptSlot);
    phase = 'blockhash';
    const blockResult = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: accountSlot }]);
    const quoteStartSlot = rpcContext(blockResult, accountSlot);
    const { blockhash, lastValidBlockHeight } = blockResult.value ?? {};
    need(typeof blockhash === 'string' && Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0, 'INVALID_LATEST_BLOCKHASH');
    phase = 'fees';
    // Quote EVERY canonical message, including the different final insertion.
    // A shared blockhash is a quote snapshot only, not a queue to sign/send.
    const steps = await mapBounded(plan.steps, concurrency, async (step, index) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
      tx.message.recentBlockhash = blockhash;
      const bytes = tx.message.serialize();
      const result = await rpc.call('getFeeForMessage', [Buffer.from(bytes).toString('base64'), { commitment: 'confirmed', minContextSlot: quoteStartSlot }]);
      const slot = rpcContext(result, quoteStartSlot);
      need(result.value !== null, 'FEE_QUOTE_UNAVAILABLE');
      const fee = rpcAmount(result.value);
      need(fee > 0n, 'INVALID_FEE_QUOTE');
      const accountRent = sum(rentItems.filter(item => item.stepId === step.id).map(item => item.lamports));
      const protocol = sum(model.protocolItems.filter(item => item.stepId === step.id).map(item => item.lamports));
      return { stepId: step.id, alreadyVerified: index <= completedIndex, messageSha256: digest(bytes), quoteSlot: slot,
        networkFeeLamports: fee.toString(), accountRentLamports: accountRent.toString(), protocolLamports: protocol.toString(),
        estimatedLamports: (fee + accountRent + protocol).toString() };
    });
    const maxQuoteSlot = Math.max(quoteStartSlot, ...steps.map(step => step.quoteSlot));
    phase = 'balance';
    const balanceResult = await rpc.call('getBalance', [plan.roles.owner, { commitment: 'finalized', minContextSlot: accountSlot }]);
    const balanceSlot = rpcContext(balanceResult, accountSlot), balance = rpcAmount(balanceResult.value);
    phase = 'blockhash';
    const valid = await rpc.call('isBlockhashValid', [blockhash, { commitment: 'confirmed', minContextSlot: Math.max(maxQuoteSlot, balanceSlot) }]);
    const checkedSlot = rpcContext(valid, Math.max(maxQuoteSlot, balanceSlot));
    need(valid.value === true, 'BUDGET_BLOCKHASH_EXPIRED');
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: checkedSlot }]);
    need(Number.isSafeInteger(height) && height >= 0 && height < lastValidBlockHeight, 'BUDGET_BLOCK_HEIGHT_EXPIRED');
    phase = 'journal';
    await assertJournalUnchanged(directory, baseline);
    need(performance.now() - startedAt <= 120000, 'BUDGET_QUOTE_TOO_OLD');
    const remaining = steps.filter(step => !step.alreadyVerified);
    const baseTotal = sum(steps.map(step => step.estimatedLamports));
    const remainingTotal = sum(remaining.map(step => step.estimatedLamports));
    const maxFee = remaining.reduce((max, step) => BigInt(step.networkFeeLamports) > max ? BigInt(step.networkFeeLamports) : max, 0n);
    const retryAllowance = maxFee * BigInt(retryTransactions);
    const buffer = (remainingTotal * BigInt(bufferBasisPoints) + 9999n) / 10000n;
    const planningTotal = remainingTotal + retryAllowance + buffer;
    const assumptions = [...model.assumptions, ...(unverifiedSpent.length ? ['some-past-attempt-costs-unverified'] : [])];
    return { status: 'budget-estimated', ...snapshotBinding(baseline, remaining[0]?.stepId ?? null),
      cluster: plan.cluster, genesisHash, checkedAt: new Date().toISOString(), accountSlot, checkedSlot, balanceSlot,
      blockhash, lastValidBlockHeight, model, rentQuotes, rentItems, steps,
      estimates: {
        networkFeesLamports: sum(steps.map(step => step.networkFeeLamports)).toString(),
        accountRentLamports: sum(rentItems.map(item => item.lamports)).toString(),
        protocolLamports: sum(model.protocolItems.map(item => item.lamports)).toString(),
        fullDeploymentLamports: baseTotal.toString(), fullDeploymentSol: formatSol(baseTotal),
        remainingSteps: remaining.length, remainingLamports: remainingTotal.toString(),
        retryTransactions, retryFeeAllowanceLamports: retryAllowance.toString(),
        bufferBasisPoints, bufferLamports: buffer.toString(), planningBalanceLamports: planningTotal.toString(),
        ownerBalanceLamports: balance.toString(), shortfallLamports: (planningTotal > balance ? planningTotal - balance : 0n).toString(),
      },
      incurred: { complete: unverifiedSpent.length === 0, receipts: incurred, unverifiedAttempts: unverifiedSpent,
        verifiedNetworkFeesLamports: sum(incurred.map(item => item.networkFeeLamports)).toString(),
        verifiedOwnerDebitLamports: sum(incurred.map(item => item.ownerDebitLamports)).toString() },
      modelComplete: true, quotesComplete: true, budgetComplete: false, assumptions,
      fundingRecommendationLamports: null, lifetimeGuaranteed: false, simulationVerified: false,
      networkRequests: rpc.requests, journalWrites: 0, transactionsSent: 0, readyToSubmit: false, salesOpen: false };
  } catch (error) { return { ...blockedDeploymentReport(error, phase, rpc, 'blocked'), budgetComplete: false, quotesComplete: false }; }
}
