// Retry only reads/simulation. Signing and submission belong to Phantom.
const READS = new Set(['getGenesisHash', 'getBalance', 'getLatestBlockhash',
  'simulateTransaction', 'getAccountInfo', 'getSignatureStatuses', 'getEpochInfo']);
export function retryDelay(value, now, fallback) {
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : fallback;
}
export function createRpcFetch({ fetchImpl = globalThis.fetch, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onEvent = () => {},
  timeoutMs = 12000, budgetMs = 45000, minIntervalMs = 800, maxAttempts = 3 } = {}) {
  let queue = Promise.resolve(), nextAt = 0, limitedUntil = 0;
  const events = [];
  function emit(event) {
    events.push({ at: new Date(now()).toISOString(), ...event });
    if (events.length > 30) events.shift();
    onEvent(event);
  }
  function failure(code, method) { return Object.assign(Error(code), { code, method, retryAt: limitedUntil }); }
  async function run(url, init, deadline) {
    let method = 'unknown';
    try { method = JSON.parse(init.body).method || method; } catch {}
    const safe = READS.has(method);
    for (let attempt = 1; attempt <= (safe ? maxAttempts : 1); attempt++) {
      const pause = Math.max(nextAt, limitedUntil) - now();
      if (pause > 0) {
        if (now() + pause >= deadline) throw failure(limitedUntil > now() ? 'RPC_RATE_LIMIT' : 'RPC_TIMEOUT', method);
        emit({ type: 'waiting', method, attempt, waitMs: pause, rateLimited: limitedUntil > now() });
        await wait(pause);
      }
      if (now() >= deadline) throw failure('RPC_TIMEOUT', method);
      if (init.signal?.aborted) throw failure('RPC_ABORTED', method);
      const controller = new AbortController();
      const abort = () => controller.abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(timeoutMs, deadline - now()));
      let response, body;
      emit({ type: 'request', method, attempt });
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
        body = await response.text();
      } catch (error) {
        emit({ type: 'error', method, attempt, code: init.signal?.aborted ? 'RPC_ABORTED' : controller.signal.aborted ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE' });
        throw failure(init.signal?.aborted ? 'RPC_ABORTED' : controller.signal.aborted ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE', method);
      } finally {
        clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
        nextAt = now() + minIntervalMs;
      }
      let rpcCode;
      try { rpcCode = JSON.parse(body)?.error?.code; } catch {}
      const rateLimited = response.status === 429 || rpcCode === 429;
      emit({ type: 'response', method, attempt, httpStatus: response.status, ...(rpcCode == null ? {} : { rpcCode }) });
      if (rateLimited) {
        const delay = Math.max(minIntervalMs, retryDelay(response.headers.get('Retry-After'), now(), 5000 * 2 ** (attempt - 1)));
        limitedUntil = Math.max(limitedUntil, now() + delay);
        emit({ type: 'limited', method, attempt, retryAt: limitedUntil });
        if (!safe || attempt === maxAttempts || limitedUntil >= deadline) throw failure('RPC_RATE_LIMIT', method);
        continue;
      }
      if (response.status === 403) throw failure('RPC_ACCESS_DENIED', method);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  }
  return {
    fetch(url, init = {}) {
      const deadline = now() + budgetMs;
      const result = queue.then(() => run(url, init, deadline));
      queue = result.catch(() => {});
      return result;
    },
    diagnostics: () => events.map(event => ({ ...event })),
    retryAt: () => limitedUntil,
  };
}

export function rpcMessage(code, hasIntent) {
  const next = hasIntent ? 'Сохранённую операцию проверь кнопкой «Проверить результат».'
    : 'Запрос подписи не отправлен. Сначала нажми «Проверить связь».';
  const messages = {
    RPC_RATE_LIMIT: `Сервер Devnet ограничил запросы. ${next}`,
    RPC_TIMEOUT: `Сервер Devnet не ответил вовремя. ${next}`,
    RPC_UNAVAILABLE: `Нет ответа от сервера Devnet. ${next}`,
    RPC_ACCESS_DENIED: 'Сервер Devnet отклонил доступ. Скопируй диагностику и пришли её в чат.',
    RPC_ABORTED: `Запрос к Devnet прерван. ${next}`,
  };
  return messages[code];
}
