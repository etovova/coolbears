// Wallet messages can contain provider URLs or arbitrary data. Retain only
// known categories, known numeric codes, and validated timing information.
const outcomes = new Set(['pending', 'submitted', 'rejected', 'error']);
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
