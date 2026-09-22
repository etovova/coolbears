import { settings as S, rpcPolicy } from './settings.mjs';

// Endpoints may contain provider credentials. Never put them, response bodies or
// native fetch errors into diagnostics, retry events or operation journals.
export class RpcError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'RpcError'; this.code = code;
    Object.assign(this, details);
  }
}

export function validateRpcEndpoint(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\#]/.test(value)) throw Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw Error();
    return url.href;
  } catch {
    throw new RpcError('ENDPOINT', 'RPC: нужен полный HTTPS-адрес без логина, пароля и фрагмента #.');
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  value = value.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  // Retry-After is either integer seconds or an HTTP date, never a decimal.
  if (!/^[A-Za-z]{3},/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function abortError(signal) {
  return signal.reason instanceof RpcError ? signal.reason : new RpcError('ABORTED', 'Проверка RPC отменена.');
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function checkedRequest(url, options, endpoint) {
  if (validateRpcEndpoint(String(url)) !== endpoint) throw new RpcError('ENDPOINT', 'Unexpected RPC endpoint');
  let request;
  try { request = JSON.parse(options.body); } catch { throw new RpcError('REQUEST', 'Invalid RPC request'); }
  if (!request || Array.isArray(request) || typeof request.method !== 'string') throw new RpcError('REQUEST', 'Invalid RPC request');
  if (!/^(get[A-Z][A-Za-z]*|isBlockhashValid|simulateTransaction)$/.test(request.method) || (options.method && options.method.toUpperCase() !== 'POST')) {
    throw new RpcError('READ_ONLY', 'Read-only RPC: подпись и отправка выполняются только кошельком.');
  }
  return request;
}
function statusError(status, retryMs = null) {
  const messages = {
    429: 'RPC HTTP 429: лимит запросов. Нужна пауза или отдельный Devnet RPC.',
    401: 'RPC HTTP 401: проверь доступ у RPC-провайдера.',
    403: 'RPC HTTP 403: RPC-провайдер запретил доступ с этого сайта или устройства.',
  };
  return new RpcError('HTTP', messages[status] || `RPC HTTP ${status}: сервис временно недоступен.`, { status, retryAfterMs: retryMs });
}

// web3.js wraps some fetch failures in plain Errors, and its schema errors can
// print an entire malformed result. Retain only fixed, known diagnostics.
export function safeRpcError(error) {
  if (error instanceof RpcError) return error;
  const message = String(error?.message ?? '');
  const status = /RPC HTTP (\d{3}):/.exec(message)?.[1];
  if (status) return statusError(Number(status));
  if (message.includes('Проверка RPC отменена.')) return new RpcError('ABORTED', 'Проверка RPC отменена.');
  if (message.includes('RPC не ответил за ') || message.includes('RPC: превышено время ожидания ответа.')) return new RpcError('TIMEOUT', 'RPC не ответил вовремя. Повтори проверку результата позже.');
  if (message.includes('RPC недоступен:')) return new RpcError('NETWORK', 'RPC недоступен: проверь интернет, разрешения RPC для сайта и настройки доступа.');
  if (message.includes('Read-only RPC:')) return new RpcError('READ_ONLY', 'Read-only RPC: подпись и отправка выполняются только кошельком.');
  return new RpcError('RESPONSE', 'RPC вернул некорректный ответ. Проверь настройки доступа и сеть Devnet.');
}

// One fixed endpoint per client; no endpoint rotation. Retries are bounded and
// only repeat reads or simulations. A 429 cooldown also applies to later calls.
export function makeReadFetch(fetchImpl = globalThis.fetch, configuration = {}) {
  if (typeof configuration === 'number') configuration = { totalTimeoutMs: configuration, attemptTimeoutMs: configuration };
  const config = { ...rpcPolicy, ...configuration };
  const endpoint = validateRpcEndpoint(config.endpoint ?? S.rpc);
  for (const key of ['totalTimeoutMs', 'attemptTimeoutMs', 'baseDelayMs', 'maxDelayMs', 'maxAttempts', 'maxPending']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new RpcError('CONFIG', 'Некорректная настройка RPC.');
  }
  if (config.maxAttempts > 3 || config.maxPending > 8) throw new RpcError('CONFIG', 'Превышен предел повторов RPC.');
  if (!Number.isSafeInteger(config.minIntervalMs) || config.minIntervalMs < 0) throw new RpcError('CONFIG', 'Некорректная частота RPC.');
  const emit = event => { try { config.onRetry?.(Object.freeze(event)); } catch { /* UI diagnostics cannot break transport. */ } };
  let tail = Promise.resolve(), pending = 0, notBefore = 0, nextRequestAt = 0, cooldownError = null;

  return async (url, options = {}) => {
    const request = checkedRequest(url, options, endpoint);
    if (pending >= config.maxPending) throw new RpcError('BUSY', 'Проверка RPC уже выполняется. Дождись результата.');
    const controller = new AbortController();
    const cancel = () => controller.abort(new RpcError('ABORTED', 'Проверка RPC отменена.'));
    // A persistent client preserves cooldowns between manual checks. A new
    // network phase may supply its own overall deadline through getSignal().
    const signals = [...new Set([options.signal, config.signal, config.getSignal?.()].filter(Boolean))];
    signals.forEach(signal => signal.addEventListener('abort', cancel, { once: true }));
    if (signals.some(signal => signal.aborted)) cancel();
    const deadline = Date.now() + config.totalTimeoutMs;
    const timer = setTimeout(() => controller.abort(new RpcError('TIMEOUT', `RPC не ответил за ${Math.ceil(config.totalTimeoutMs / 1000)} секунд. Проверь подключение и повтори проверку результата.`)), config.totalTimeoutMs);
    const previous = tail;
    let release;
    const slot = new Promise(resolve => { release = resolve; });
    tail = previous.then(() => slot);
    pending++;
    try {
      await abortable(previous, controller.signal);
      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        const remainingCooldown = Math.max(0, notBefore - Date.now());
        if (remainingCooldown >= deadline - Date.now()) throw cooldownError || statusError(429, remainingCooldown);
        const delay = Math.max(remainingCooldown, nextRequestAt - Date.now(), 0);
        if (delay >= deadline - Date.now()) throw new RpcError('TIMEOUT', 'Время проверки RPC истекло до следующего запроса.');
        if (delay) await wait(delay, controller.signal);
        if (controller.signal.aborted) throw abortError(controller.signal);
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort(abortError(controller.signal));
        controller.signal.addEventListener('abort', abortAttempt, { once: true });
        const attemptTimer = setTimeout(() => attemptController.abort(new RpcError('ATTEMPT_TIMEOUT', 'RPC: превышено время ожидания ответа.')), Math.min(config.attemptTimeoutMs, Math.max(1, deadline - Date.now())));
        let failure, retryMs = null;
        try {
          nextRequestAt = Date.now() + config.minIntervalMs;
          const response = await abortable(Promise.resolve().then(() => fetchImpl(endpoint, {
            ...options, signal: attemptController.signal, method: 'POST',
            credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
          })), attemptController.signal);
          if (!response.ok) {
            retryMs = retryAfterMs(response.headers.get('retry-after'));
            // Discard bodies: a provider can include keys or untrusted HTML.
            try { await abortable(response.body?.cancel(), attemptController.signal); } catch { /* The request remains bounded. */ }
            throw statusError(response.status, retryMs);
          }
          const text = await abortable(response.text(), attemptController.signal);
          let data;
          try { data = JSON.parse(text); } catch { throw new RpcError('RESPONSE', 'RPC вернул некорректный ответ.'); }
          if (!data || Array.isArray(data) || data.id !== request.id || data.jsonrpc !== '2.0') throw new RpcError('RESPONSE', 'RPC вернул некорректный ответ.');
          if (data.error) {
            const code = Number.isSafeInteger(data.error.code) ? data.error.code : 'unknown';
            throw new RpcError('RPC', `RPC: ошибка ${code}. Проверь настройки доступа и сеть Devnet.`);
          }
          if (!Object.hasOwn(data, 'result')) throw new RpcError('RESPONSE', 'RPC вернул неполный ответ.');
          return new Response(text, { status: response.status, headers: response.headers });
        } catch (error) {
          if (controller.signal.aborted) throw abortError(controller.signal);
          failure = error instanceof RpcError ? error : new RpcError('NETWORK', 'RPC недоступен: проверь интернет, разрешения RPC для сайта и настройки доступа.');
        } finally {
          clearTimeout(attemptTimer);
          controller.signal.removeEventListener('abort', abortAttempt);
        }
        const retriable = ['NETWORK', 'ATTEMPT_TIMEOUT'].includes(failure.code) || (failure.code === 'HTTP' && [408, 429, 500, 502, 503, 504].includes(failure.status));
        if (!retriable) throw failure;
        // Never shorten Retry-After. If it exceeds our deadline, fail promptly
        // and preserve the cooldown instead of retrying early.
        const delayMs = Math.max(retryMs ?? 0, Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** (attempt - 1))));
        notBefore = Math.max(notBefore, Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delayMs));
        cooldownError = failure;
        if (attempt >= config.maxAttempts || delayMs >= deadline - Date.now()) throw failure;
        emit({ attempt, maxAttempts: config.maxAttempts, delayMs, status: failure.status ?? null, code: failure.code });
      }
      throw new RpcError('NETWORK', 'RPC недоступен.');
    } finally {
      clearTimeout(timer); signals.forEach(signal => signal.removeEventListener('abort', cancel));
      pending--; release();
    }
  };
}
