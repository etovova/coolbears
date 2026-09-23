// Sequential fee reads for a NON-ATOMIC planning preview. These are not
// signable deployment attempts and never replace saved journal bytes.
import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { rpcContext, rpcAmount, requireDeploymentCheck as need } from './read.mjs';

export async function quotePreviewFeeWindows({ plan, rpc, minimumSlot = 0, windowSize = 24, onProgress = () => {} } = {}) {
  need(Array.isArray(plan?.steps) && plan.steps.length > 0 && plan.steps.length <= 20000, 'INVALID_PREVIEW_PLAN');
  need(new Set(plan.steps.map(step => step.id)).size === plan.steps.length, 'DUPLICATE_PREVIEW_STEP');
  need(Number.isSafeInteger(windowSize) && windowSize >= 1 && windowSize <= 24, 'INVALID_PREVIEW_WINDOW');
  need(Number.isSafeInteger(minimumSlot) && minimumSlot >= 0 && typeof onProgress === 'function', 'INVALID_PREVIEW_OPTIONS');
  const steps = [], windows = [];
  let minimum = minimumSlot;
  for (let offset = 0; offset < plan.steps.length; offset += windowSize) {
    const startedAt = new Date().toISOString();
    const block = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: minimum }]);
    const startSlot = rpcContext(block, minimum);
    const { blockhash, lastValidBlockHeight } = block.value ?? {};
    need(typeof blockhash === 'string' && Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0, 'INVALID_LATEST_BLOCKHASH');
    let maxSlot = startSlot;
    const pending = [];
    for (const step of plan.steps.slice(offset, offset + windowSize)) {
      const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
      need(tx.signatures.every(signature => signature.every(byte => byte === 0)), 'PREVIEW_REQUIRES_UNSIGNED_TEMPLATE');
      tx.message.recentBlockhash = blockhash;
      const bytes = tx.message.serialize();
      const result = await rpc.call('getFeeForMessage', [Buffer.from(bytes).toString('base64'), { commitment: 'confirmed', minContextSlot: startSlot }]);
      const slot = rpcContext(result, startSlot);
      need(result.value !== null, 'FEE_QUOTE_UNAVAILABLE');
      const fee = rpcAmount(result.value);
      need(fee > 0n, 'INVALID_FEE_QUOTE');
      maxSlot = Math.max(maxSlot, slot);
      pending.push({ stepId: step.id, window: windows.length, quoteSlot: slot,
        requiredSignatures: tx.message.header.numRequiredSignatures,
        messageSha256: createHash('sha256').update(bytes).digest('hex'), networkFeeLamports: fee.toString() });
    }
    const valid = await rpc.call('isBlockhashValid', [blockhash, { commitment: 'confirmed', minContextSlot: maxSlot }]);
    const checkedSlot = rpcContext(valid, maxSlot);
    need(valid.value === true, 'PREVIEW_WINDOW_BLOCKHASH_EXPIRED');
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: checkedSlot }]);
    need(Number.isSafeInteger(height) && height >= 0 && height < lastValidBlockHeight, 'PREVIEW_WINDOW_HEIGHT_EXPIRED');
    steps.push(...pending);
    windows.push({ index: windows.length, firstStep: offset, count: pending.length, blockhash,
      lastValidBlockHeight, startSlot, checkedSlot, checkedBlockHeight: height, startedAt, checkedAt: new Date().toISOString() });
    minimum = checkedSlot;
    onProgress({ quotedMessages: steps.length, totalMessages: plan.steps.length, completedWindows: windows.length });
  }
  const total = steps.reduce((value, step) => value + BigInt(step.networkFeeLamports), 0n);
  const maximum = steps.reduce((value, step) => BigInt(step.networkFeeLamports) > value ? BigInt(step.networkFeeLamports) : value, 0n);
  return { steps, windows, networkFeesLamports: total.toString(), maxNetworkFeeLamports: maximum.toString(),
    everyMessageQuoted: true, allQuotesSimultaneouslyFresh: false, signable: false };
}
