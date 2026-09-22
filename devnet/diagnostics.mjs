// Wallet messages can contain provider URLs or arbitrary data. Retain only
// known categories, known numeric codes, and validated timing information.
const outcomes = new Set(['pending', 'signed', 'submitted', 'rejected', 'error']);
const categories = new Set(['user-rejected', 'transaction-error', 'blockhash-expired', 'wallet-disconnected', 'network-error', 'invalid-response', 'wallet-error']);
const codes = new Set([-32000, -32002, -32003, -32601, -32602, -32603, 4001, 4100, 4900]);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

export function walletErrorDetails(error) {
  const rawCode = error?.code ?? error?.cause?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  let errorCategory = 'wallet-error';
  if (rawCode === 4001) errorCategory = 'user-rejected';
  else if (/blockhash|block height exceeded|transaction.*expired/i.test(message)) errorCategory = 'blockhash-expired';
  else if (rawCode === 4900 || /Кошелёк (изменился|сменил аккаунт)/.test(message)) errorCategory = 'wallet-disconnected';
  else if (/Кошелёк не вернул подпись/.test(message)) errorCategory = 'invalid-response';
  else if (/failed to fetch|network error|network request failed|HTTP 429/i.test(message)) errorCategory = 'network-error';
  else if (rawCode === -32003 || /transaction.*(rejected|failed)|simulation failed/i.test(message)) errorCategory = 'transaction-error';
  return { errorCategory, ...(codes.has(rawCode) ? { errorCode: rawCode } : {}) };
}

export function publicWalletAttempt(value) {
  if (!value || !outcomes.has(value.outcome) || !iso(value.requestedAt)) return null;
  const result = {
    wallet: ['phantom', 'solflare', 'backpack'].includes(value.wallet) ? value.wallet : 'other',
    transport: ['standard', 'injected'].includes(value.transport) ? value.transport : 'other',
    requestedAt: value.requestedAt, outcome: value.outcome,
  };
  if (['signTransaction', 'signAndSendTransaction'].includes(value.method)) result.method = value.method;
  for (const field of ['responseAt', 'timeoutAt']) if (iso(value[field])) result[field] = value[field];
  if (categories.has(value.errorCategory)) result.errorCategory = value.errorCategory;
  if (codes.has(value.errorCode)) result.errorCode = value.errorCode;
  return result;
}

export function mergeWalletAttempt(incoming, saved) {
  incoming = publicWalletAttempt(incoming); saved = publicWalletAttempt(saved);
  if (!incoming) return saved;
  if (!saved) return incoming;
  // An in-flight recovery snapshot must not erase a later wallet response,
  // including an error which did not produce a transaction signature.
  const chosen = saved.responseAt && (!incoming.responseAt || saved.responseAt > incoming.responseAt) ? saved : incoming;
  return { ...chosen, ...((saved.timeoutAt || incoming.timeoutAt) ? { timeoutAt: saved.timeoutAt || incoming.timeoutAt } : {}) };
}

export function publicPreparation(value) {
  if (!value || !iso(value.startedAt) || !iso(value.readyAt) ||
      !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 90000 ||
      !Number.isSafeInteger(value.remainingBlocks) || value.remainingBlocks < 0 || value.remainingBlocks > 1000 ||
      ![1, 2].includes(value.attempt)) return null;
  return { startedAt: value.startedAt, readyAt: value.readyAt, elapsedMs: value.elapsedMs, remainingBlocks: value.remainingBlocks, attempt: value.attempt };
}

const submissionStates = ['not-sent', 'sending', 'unknown', 'accepted'];
const senderCategories = new Set(['ENDPOINT', 'INPUT', 'CONFIG', 'HTTP', 'RPC', 'NETWORK', 'TIMEOUT', 'ABORTED', 'INVALID_RESPONSE']);
export function publicSubmission(value) {
  if (!value || value.route !== 'custom-rpc' || !submissionStates.includes(value.state) || !iso(value.updatedAt)) return null;
  const result = { route: 'custom-rpc', state: value.state, updatedAt: value.updatedAt };
  if (senderCategories.has(value.errorCategory)) result.errorCategory = value.errorCategory;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if ([-32700, -32600, -32601, -32602, -32603, -32000, -32002, -32003, -32004, -32005, -32007, -32009, -32014, -32015, -32016].includes(value.errorCode)) result.errorCode = value.errorCode;
  return result;
}

export function mergeSubmission(incoming, saved) {
  incoming = publicSubmission(incoming); saved = publicSubmission(saved);
  if (!incoming) return saved;
  if (!saved) return incoming;
  // Recovery snapshots cannot erase a broadcast already attempted/accepted.
  const rank = value => submissionStates.indexOf(value.state);
  if (rank(saved) > rank(incoming)) return saved;
  if (rank(saved) < rank(incoming)) return incoming;
  return saved.updatedAt > incoming.updatedAt ? saved : incoming;
}
