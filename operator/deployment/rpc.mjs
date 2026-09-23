// Explicit read-only deployment inspection. No signing, submission,
// automatic retry or endpoint fallback is available through this transport.
// Simulation requires an explicit opt-in and never replaces a blockhash.
// Full genesis hashes: official Solana ClusterType::get_genesis_hash source:
// https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs
export const GENESIS_HASHES = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});

const METHODS = new Set([
  'getGenesisHash', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash',
  'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'getSignatureStatuses',
  'getTransaction', 'isBlockhashValid', 'getBlockHeight',
]);
const MESSAGES = Object.freeze({
  CONFIGURATION: 'Invalid deployment RPC configuration.',
  ENDPOINT: 'Deployment RPC requires an explicit HTTPS endpoint without credentials or a fragment.',
  METHOD: 'This deployment RPC method is not allowed.',
  PARAMS: 'Invalid deployment RPC parameters.',
  TIMEOUT: 'Deployment RPC exceeded its response deadline.',
  NETWORK: 'Deployment RPC could not be reached.',
  HTTP: 'Deployment RPC returned an unsuccessful HTTP status.',
  REDIRECT: 'Deployment RPC redirects are not allowed.',
  RESPONSE_SIZE: 'Deployment RPC response exceeded the size limit.',
  RESPONSE: 'Deployment RPC returned an invalid response.',
  RPC: 'Deployment RPC returned an RPC error.',
  CLUSTER: 'Unsupported deployment cluster.',
  GENESIS: 'Deployment RPC does not match the requested cluster.',
});
export class DeploymentRpcError extends Error {
  constructor(code, status) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'RESPONSE';
    super(MESSAGES[known]); this.name = 'DeploymentRpcError'; this.code = known;
    if (known === 'HTTP' && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}
const fail = (code, status) => new DeploymentRpcError(code, status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function endpointUrl(endpoint) {
  try {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\s\\#]/.test(endpoint)) throw Error();
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw Error();
    return url.href;
  } catch { throw fail('ENDPOINT'); }
}
function cancel(stream) {
  try { void stream?.cancel()?.catch(() => {}); } catch { /* Never await cleanup from an untrusted response. */ }
}
async function readBody(response, signal, limit, expiresAt) {
  let reader;
  const abort = () => cancel(reader);
  try {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw fail('RESPONSE_SIZE');
    if (!response.body || typeof response.body.getReader !== 'function') throw fail('RESPONSE');
    reader = response.body.getReader();
    signal.addEventListener('abort', abort, { once: true });
    let bytes = new Uint8Array(Math.min(limit, 8192)), size = 0;
    while (true) {
      if (signal.aborted || performance.now() >= expiresAt) throw fail('TIMEOUT');
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw fail('RESPONSE');
      const needed = size + value.byteLength;
      if (needed > limit) throw fail('RESPONSE_SIZE');
      if (needed > bytes.length) {
        const grown = new Uint8Array(Math.min(limit, Math.max(needed, bytes.length * 2)));
        grown.set(bytes); bytes = grown;
      }
      bytes.set(value, size); size = needed;
    }
    if (signal.aborted || performance.now() >= expiresAt) throw fail('TIMEOUT');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw fail('RESPONSE'); }
  } finally {
    signal.removeEventListener('abort', abort);
    if (reader) { cancel(reader); try { reader.releaseLock(); } catch { /* A hostile read may still be pending. */ } }
    else cancel(response.body);
  }
}

export function createDeploymentRpc({ endpoint, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15000, totalTimeoutMs, maxResponseBytes = 4 * 1024 * 1024, allowSimulation = false } = {}) {
  const url = endpointUrl(endpoint);
  if (typeof allowSimulation !== 'boolean' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024
    || (totalTimeoutMs !== undefined && (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 120000))) throw fail('CONFIGURATION');
  const startedAt = performance.now();
  let requests = 0;
  return Object.freeze({
    get requests() { return requests; },
    async call(method, params = []) {
      if (typeof method !== 'string' || !(METHODS.has(method) || (allowSimulation && method === 'simulateTransaction'))) throw fail('METHOD');
      if (!Array.isArray(params)) throw fail('PARAMS');
      if (method === 'simulateTransaction') {
        const [bytes, config] = params;
        if (params.length !== 2 || typeof bytes !== 'string' || bytes.length > 1644 || !object(config)
          || Object.keys(config).sort().join(',') !== 'commitment,encoding,minContextSlot,replaceRecentBlockhash,sigVerify'
          || config.encoding !== 'base64' || config.commitment !== 'confirmed'
          || config.replaceRecentBlockhash !== false || typeof config.sigVerify !== 'boolean'
          || !Number.isSafeInteger(config.minContextSlot) || config.minContextSlot < 0) throw fail('PARAMS');
      }
      const id = requests + 1;
      if (!Number.isSafeInteger(id)) throw fail('CONFIGURATION');
      let body;
      try {
        body = JSON.stringify({ jsonrpc: '2.0', id, method, params }, (_key, value) => {
          if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)
            || (typeof value === 'number' && !Number.isFinite(value))) throw Error();
          return value;
        });
        if (new TextEncoder().encode(body).length > 65536) throw Error();
      } catch { throw fail('PARAMS'); }
      const remaining = totalTimeoutMs === undefined ? timeoutMs : totalTimeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) throw fail('TIMEOUT');
      const callTimeoutMs = Math.min(timeoutMs, remaining);
      requests = id;
      const controller = new AbortController();
      const expiresAt = performance.now() + callTimeoutMs;
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail('TIMEOUT')); }, callTimeoutMs);
      });
      const operation = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw fail('TIMEOUT');
        let response;
        try {
          response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body,
            signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
        } catch { throw fail(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK'); }
        if (controller.signal.aborted) { cancel(response?.body); throw fail('TIMEOUT'); }
        if (response?.redirected) { cancel(response.body); throw fail('REDIRECT'); }
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) { cancel(response?.body); throw fail('RESPONSE'); }
        if (response.status < 200 || response.status >= 300) { cancel(response.body); throw fail('HTTP', response.status); }
        const data = await readBody(response, controller.signal, maxResponseBytes, expiresAt);
        if (controller.signal.aborted || performance.now() >= expiresAt) throw fail('TIMEOUT');
        const result = object(data) && Object.hasOwn(data, 'result');
        const error = object(data) && Object.hasOwn(data, 'error');
        if (!object(data) || data.jsonrpc !== '2.0' || data.id !== id || result === error
          || Object.keys(data).length !== 3) throw fail('RESPONSE');
        if (error) {
          if (!object(data.error) || !Number.isSafeInteger(data.error.code) || typeof data.error.message !== 'string') throw fail('RESPONSE');
          throw fail('RPC');
        }
        return data.result; // null is a legitimate Solana RPC result.
      });
      try { return await Promise.race([operation, deadline]); }
      catch (error) { throw error instanceof DeploymentRpcError ? error : fail(controller.signal.aborted ? 'TIMEOUT' : 'RESPONSE'); }
      finally { clearTimeout(timer); controller.abort(); }
    },
  });
}

export async function assertCluster(rpc, cluster) {
  if (typeof cluster !== 'string' || !Object.hasOwn(GENESIS_HASHES, cluster)) throw fail('CLUSTER');
  if (!rpc || typeof rpc.call !== 'function') throw fail('CONFIGURATION');
  let genesis;
  try { genesis = await rpc.call('getGenesisHash', []); }
  catch (error) { throw error instanceof DeploymentRpcError ? error : fail('NETWORK'); }
  if (genesis !== GENESIS_HASHES[cluster]) throw fail('GENESIS');
  return genesis;
}
