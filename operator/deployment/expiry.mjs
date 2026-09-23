// Bounded, trusted-RPC absence verification. No signing, submission or storage.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { inspectSignedDeploymentTransaction } from './signing.mjs';
import { GENESIS_HASHES } from './rpc.mjs';
import { validRecoverySignature } from './request-policy.mjs';
export class DeploymentExpiryError extends Error {
  constructor(code) { super('Deployment expiry could not be verified.'); this.code = code; }
}
const need = (value, code) => { if (!value) throw new DeploymentExpiryError(code); };
const uint = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => uint(n) && n > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const address = v => { try { return typeof v === 'string' && new PublicKey(v).toBase58() === v; } catch { return false; } };
export const EXPIRY_FIELDS = ['blockhash', 'anchorSlot', 'slot', 'blockHeight', 'lastValidBlockHeight', 'historyPages', 'historySha256'];
export const validExpiryEvidence = value => object(value) && address(value.blockhash) && positive(value.anchorSlot)
  && positive(value.slot) && value.slot >= value.anchorSlot && positive(value.lastValidBlockHeight)
  && positive(value.blockHeight) && value.blockHeight > value.lastValidBlockHeight
  && positive(value.historyPages) && value.historyPages <= 10 && typeof value.historySha256 === 'string'
  && /^[0-9a-f]{64}$/.test(value.historySha256);
export function validateHashAnchor(value) {
  need(object(value) && Object.keys(value).sort().join(',') === 'blockhash,lastValidBlockHeight,slot,version'
    && value.version === 1 && address(value.blockhash) && positive(value.slot)
    && positive(value.lastValidBlockHeight), 'EXPIRY_ANCHOR_REQUIRED');
  return value;
}
export function anchorFromLatestBlockhash(result, minContextSlot = 0) {
  return validateHashAnchor({ version: 1, blockhash: result?.value?.blockhash,
    lastValidBlockHeight: result?.value?.lastValidBlockHeight,
    slot: uint(result?.context?.slot) && result.context.slot >= minContextSlot ? result.context.slot : null });
}
const blockOptions = { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 };
function blockHeader(value, slot) {
  need(object(value) && positive(value.blockHeight) && uint(value.parentSlot) && value.parentSlot < slot
    && address(value.blockhash), 'EXPIRY_BLOCK_UNAVAILABLE');
  return value;
}
export async function verifyExpiredTransaction({ transactionBase64, anchor: inputAnchor, minContextSlot = 0, call }) {
  const signed = inspectSignedDeploymentTransaction(transactionBase64);
  const tx = VersionedTransaction.deserialize(Buffer.from(signed.transactionBase64, 'base64'));
  const anchor = structuredClone(validateHashAnchor(inputAnchor));
  need(anchor.blockhash === tx.message.recentBlockhash && uint(minContextSlot), 'EXPIRY_ANCHOR_MISMATCH');
  const started = performance.now(); let requests = 0;
  const rpc = async (method, params = []) => {
    need(performance.now() - started < 25000 && requests < 24, 'EXPIRY_REVIEW_LIMIT');
    requests++; const result = await call(method, params);
    need(performance.now() - started < 25000, 'EXPIRY_REVIEW_LIMIT'); return result;
  };
  need(await rpc('getGenesisHash') === GENESIS_HASHES.devnet, 'EXPIRY_WRONG_CLUSTER');
  const first = blockHeader(await rpc('getBlock', [anchor.slot, blockOptions]), anchor.slot);
  need(first.blockhash === anchor.blockhash && first.blockHeight <= anchor.lastValidBlockHeight, 'EXPIRY_ANCHOR_MISMATCH');
  const valid = await rpc('isBlockhashValid', [anchor.blockhash, { commitment: 'finalized', minContextSlot: Math.max(minContextSlot, anchor.slot) }]);
  need(uint(valid?.context?.slot) && valid.context.slot >= Math.max(minContextSlot, anchor.slot)
    && valid.value === false, 'EXPIRY_NOT_FINALIZED');
  const slot = valid.context.slot, last = blockHeader(await rpc('getBlock', [slot, blockOptions]), slot);
  need(last.blockHeight > anchor.lastValidBlockHeight, 'EXPIRY_NOT_FINALIZED');
  const archive = async () => {
    const firstAvailable = await rpc('getFirstAvailableBlock');
    need(uint(firstAvailable) && firstAvailable <= anchor.slot, 'EXPIRY_HISTORY_UNAVAILABLE');
  };
  const absent = async () => {
    const status = await rpc('getSignatureStatuses', [[signed.signature], { searchTransactionHistory: true }]);
    need(uint(status?.context?.slot) && status.context.slot >= slot && Array.isArray(status.value)
      && status.value.length === 1 && status.value[0] === null, 'EXPIRY_TRANSACTION_OBSERVED');
    const transaction = await rpc('getTransaction', [signed.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
    need(transaction === null, 'EXPIRY_TRANSACTION_OBSERVED');
  };
  await archive(); await absent();
  // Fee payer occurs in every candidate's accountKeys. Require an actual
  // finalized history row older than the hash's verified block; an empty or
  // truncated page alone is not evidence that the interval was covered.
  let before, previousSlot = Infinity, boundary = false, pages = 0;
  const seen = new Set(), digest = createHash('sha256');
  for (; pages < 10 && !boundary;) {
    const rows = await rpc('getSignaturesForAddress', [signed.owner, {
      commitment: 'finalized', minContextSlot: slot, limit: 100, ...(before ? { before } : {}) }]);
    pages++;
    need(Array.isArray(rows) && rows.length > 0 && rows.length <= 100, 'EXPIRY_HISTORY_INCOMPLETE');
    for (const row of rows) {
      need(object(row) && validRecoverySignature(row.signature) && positive(row.slot) && row.slot <= previousSlot
        && row.confirmationStatus === 'finalized' && Object.hasOwn(row, 'err') && !seen.has(row.signature), 'EXPIRY_HISTORY_INVALID');
      need(row.signature !== signed.signature, 'EXPIRY_TRANSACTION_OBSERVED');
      seen.add(row.signature); previousSlot = row.slot;
      digest.update(`${row.signature}:${row.slot}\n`);
      if (row.slot < anchor.slot) boundary = true;
    }
    before = rows.at(-1).signature;
    need(boundary || rows.length === 100, 'EXPIRY_HISTORY_INCOMPLETE');
  }
  need(boundary, 'EXPIRY_HISTORY_LIMIT');
  await archive(); await absent();
  return { blockhash: anchor.blockhash, anchorSlot: anchor.slot, slot, blockHeight: last.blockHeight,
    lastValidBlockHeight: anchor.lastValidBlockHeight, historyPages: pages, historySha256: digest.digest('hex') };
}
