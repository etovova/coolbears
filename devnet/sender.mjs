import { VersionedTransaction } from '@solana/web3.js';
import { base58, base64 } from '@metaplex-foundation/umi/serializers';
import { validateRpcEndpoint } from './rpc.mjs';
import { settings as S } from './settings.mjs';

const RPC_CODES = new Set([
  -32700, -32600, -32601, -32602, -32603, -32000,
  -32001, -32002, -32003, -32004, -32005, -32006, -32007, -32008,
  -32009, -32010, -32011, -32012, -32013, -32014, -32015, -32016,
]);
const MESSAGES = Object.freeze({
  ENDPOINT: 'Для этого способа отправки нужен отдельный HTTPS RPC. Публичный Devnet RPC не используется.',
  INPUT: 'Подписанная транзакция или её подпись не прошли проверку. Отправка не выполнялась.',
  CONFIG: 'Некорректная настройка отправки. Отправка не выполнялась.',
  HTTP: 'RPC не подтвердил приём транзакции. Проверь результат сохранённой операции.',
  RPC: 'RPC вернул ошибку отправки. Проверь результат сохранённой операции.',
  NETWORK: 'Ответ RPC при отправке не получен. Проверь результат сохранённой операции.',
  TIMEOUT: 'Время ожидания отправки истекло. Проверь результат сохранённой операции.',
  ABORTED: 'Ожидание отправки прервано. Проверь результат сохранённой операции.',
  INVALID_RESPONSE: 'RPC вернул неожиданный ответ при отправке. Проверь результат сохранённой операции.',
});

export class SenderError extends Error {
  constructor(code, { status, rpcCode } = {}) {
    super(MESSAGES[code] || MESSAGES.INVALID_RESPONSE);
    this.name = 'SenderError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'INVALID_RESPONSE';
    if (code === 'HTTP' && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (code === 'RPC' && RPC_CODES.has(rpcCode)) this.rpcCode = rpcCode;
  }
}

export function validateSubmissionEndpoint(endpoint) {
  try {
    const target = validateRpcEndpoint(endpoint);
    if (new URL(target).hostname.replace(/\.$/, '') === new URL(S.rpc).hostname) throw Error();
    return target;
  } catch { throw new SenderError('ENDPOINT'); }
}

function validateSubmission(bytes, expectedSignature) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 65 || bytes.length > 1232) throw Error();
    if (typeof expectedSignature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(expectedSignature)) throw Error();
    const signature = base58.serialize(expectedSignature);
    if (signature.length !== 64 || !signature.some(Boolean)) throw Error();
    // Snapshot the caller's bytes before any asynchronous work. This helper
    // never signs, alters, refreshes or recreates a transaction.
    const snapshot = new Uint8Array(bytes);
    const transaction = VersionedTransaction.deserialize(snapshot);
    if (transaction.version !== 0 || transaction.signatures.length !== transaction.message.header.numRequiredSignatures) throw Error();
    if (!transaction.signatures.every(value => value.length === 64 && value.some(Boolean))) throw Error();
    if (!transaction.signatures[0].every((byte, index) => byte === signature[index])) throw Error();
    const canonical = transaction.serialize();
    if (canonical.length !== snapshot.length || !canonical.every((byte, index) => byte === snapshot[index])) throw Error();
    return base64.deserialize(snapshot)[0];
  } catch { throw new SenderError('INPUT'); }
}

// Explicit alternative submission only. The caller must already have validated
// the Devnet genesis, immutable message and all signatures, and durably saved
// expectedSignature in the operation journal BEFORE calling this function.
// One HTTP attempt; errors and timeouts never cause another submission.
export async function sendSignedTransaction(endpoint, bytes, expectedSignature, {
  fetchImpl = globalThis.fetch, signal, timeoutMs = 15000,
} = {}) {
  const target = validateSubmissionEndpoint(endpoint);
  const encoded = validateSubmission(bytes, expectedSignature);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) throw new SenderError('CONFIG');
  if (signal?.aborted) throw new SenderError('ABORTED');

  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  // Catch an abort that happened while the parent listener was being attached.
  if (signal?.aborted) cancel();
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new SenderError(timedOut ? 'TIMEOUT' : 'ABORTED'));
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const submit = async () => {
      if (controller.signal.aborted) throw new SenderError(timedOut ? 'TIMEOUT' : 'ABORTED');
      const response = await fetchImpl(target, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [encoded, {
          encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5,
        }] }),
        signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (controller.signal.aborted) throw new SenderError(timedOut ? 'TIMEOUT' : 'ABORTED');
      if (!response.ok) {
        // Never read or report provider error text, which may echo credentials.
        try { void response.body?.cancel()?.catch(() => {}); } catch { /* Best effort body cleanup. */ }
        throw new SenderError('HTTP', { status: response.status });
      }
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new SenderError('INVALID_RESPONSE'); }
      if (!data || Array.isArray(data) || data.jsonrpc !== '2.0' || data.id !== 1) throw new SenderError('INVALID_RESPONSE');
      if (Object.hasOwn(data, 'error')) {
        if (Object.hasOwn(data, 'result') || !data.error || typeof data.error !== 'object' || Array.isArray(data.error)) throw new SenderError('INVALID_RESPONSE');
        throw new SenderError('RPC', { rpcCode: data.error.code });
      }
      if (data.result !== expectedSignature) throw new SenderError('INVALID_RESPONSE');
      return expectedSignature;
    };
    return await Promise.race([submit(), aborted]);
  } catch (error) {
    if (error instanceof SenderError) throw error;
    if (controller.signal.aborted) throw new SenderError(timedOut ? 'TIMEOUT' : 'ABORTED');
    throw new SenderError('NETWORK');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abort);
  }
}
