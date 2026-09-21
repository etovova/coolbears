import { GENESIS } from './spec.mjs';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_BACKUP_RPC = 'https://solana-devnet.api.onfinality.io/public';
const READ_METHODS = new Set([
  'getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts',
  'getLatestBlockhash', 'getBlockHeight', 'getSlot', 'getBlockTime',
  'getSignatureStatuses', 'getBalance', 'getMinimumBalanceForRentExemption',
  'getVersion', 'getEpochInfo', 'isBlockhashValid', 'simulateTransaction',
]);
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function rpcErrorMessage(error) {
  if (error?.code === 'RPC_BUSY' || /RPC_BUSY|\b429\b|rate limit|too many requests/i.test(error?.message || '')) {
    return 'Серверы Solana временно ограничили подключения. Сохранённые операции не сброшены. Подожди минуту и нажми «Создать / продолжить».';
  }
  if (error?.code === 'RPC_UNAVAILABLE' || /RPC_UNAVAILABLE/.test(error?.message || '')) {
    return 'Не удалось связаться с Solana. Сохранённые операции не сброшены. Проверь соединение и нажми «Создать / продолжить».';
  }
  return null;
}

function retryAfter(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now) || 0;
}
function transient(code, delay = 0) {
  return Object.assign(new Error(code), { code, retryable: true, delay });
}

// One serialized transport is shared by Web3.js and Umi. Only the enumerated
// read/simulation methods may be retried. A submitted transaction is never replayed.
export function createRpcFetch({ endpoint, cluster, onProgress = () => {},
  fetchImpl = (...args) => globalThis.fetch(...args), sleep = wait, now = Date.now,
  minIntervalMs = 350, requestTimeoutMs = 12000, maxElapsedMs = 45000 } = {}) {
  const normalize = value => new URL(value).href;
  const url = normalize(endpoint);
  const publicDevnet = cluster === 'devnet' && [DEVNET_RPC, DEVNET_BACKUP_RPC].some(x => normalize(x) === url);
  const endpoints = [url, ...(publicDevnet ? [DEVNET_RPC, DEVNET_BACKUP_RPC].map(normalize).filter(x => x !== url) : [])];
  const nodes = endpoints.map(url => ({ url, cooldown: 0, verifiedUntil: 0 }));
  let active = nodes[0], tail = Promise.resolve(), nextRequest = 0;

  async function request(node, init) {
    if (init.signal?.aborted) throw init.signal.reason || new Error('Request aborted');
    await sleep(Math.max(0, nextRequest - now()));
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(node.url, { ...init, signal: controller.signal });
      // Consume the body under the timeout too, keeping no abandoned response streams.
      const body = await response.text();
      let json;
      try { json = JSON.parse(body); } catch { /* HTTP error pages are handled below. */ }
      if (TRANSIENT_HTTP.has(response.status) || json?.error?.code === 429 ||
          json?.error?.code === -32005 || /rate limit|too many requests/i.test(json?.error?.message || '')) {
        throw transient(response.status === 429 || json?.error?.code === 429 || /rate limit/i.test(json?.error?.message || '') ? 'RPC_BUSY' : 'RPC_UNAVAILABLE',
          retryAfter(response.headers.get('Retry-After'), now()));
      }
      if (response.ok && !json) throw transient('RPC_UNAVAILABLE');
      return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), json };
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason || error;
      if (error.retryable) throw error;
      if (error instanceof TypeError || error.name === 'AbortError' || error.name === 'TimeoutError') throw transient('RPC_UNAVAILABLE');
      throw error;
    } finally {
      clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
      nextRequest = now() + minIntervalMs;
    }
  }

  async function run(init) {
    const payload = JSON.parse(init.body);
    const readOnly = !Array.isArray(payload) && READ_METHODS.has(payload.method);
    const deadline = now() + maxElapsedMs;
    let lastError;
    for (let attempt = 0; attempt < (readOnly ? 4 : 1); attempt++) {
      if (now() >= deadline && lastError) throw lastError;
      let node = active;
      if (node.cooldown > now()) node = nodes.reduce((a,b) => a.cooldown <= b.cooldown ? a : b);
      const delay = Math.max(0, node.cooldown - now());
      if (delay) {
        if (now() + delay >= deadline) throw lastError || transient('RPC_BUSY');
        onProgress(`Сервер Solana занят. Повторная проверка через ${Math.ceil(delay / 1000)} сек…`);
        await sleep(delay);
      }
      if (node !== active) onProgress('Проверяю резервное подключение к Solana Devnet…');
      try {
        // Verify every new endpoint before allowing any account, simulation or
        // transaction request through it. User-supplied URLs never gain a fallback.
        if (payload.method !== 'getGenesisHash' && node.verifiedUntil <= now()) {
          const check = await request(node, { ...init, body: JSON.stringify({ jsonrpc: '2.0', id: 'network-check', method: 'getGenesisHash' }) });
          if (!check.response.ok || check.json?.error) throw Error('RPC network verification failed');
          if (check.json?.result !== GENESIS[cluster]) throw Error('RPC network does not match the selected network');
          node.verifiedUntil = now() + 60000;
        }
        const result = await request(node, init);
        if (payload.method === 'getGenesisHash' && result.response.ok && !result.json?.error) {
          if (result.json?.result !== GENESIS[cluster]) throw Error('RPC network does not match the selected network');
          node.verifiedUntil = now() + 60000;
        }
        active = node;
        return result.response;
      } catch (error) {
        if (!error.retryable) throw error;
        lastError = error;
        node.cooldown = now() + Math.max(error.delay, error.code === 'RPC_BUSY' ? 10000 * (attempt + 1) : 2000 * (attempt + 1));
        // In particular, never retry sendTransaction/requestAirdrop/unknown methods.
        if (!readOnly) throw error;
      }
    }
    throw lastError;
  }
  return (_input, init) => {
    const task = tail.then(() => run(init));
    tail = task.catch(() => {});
    return task;
  };
}
