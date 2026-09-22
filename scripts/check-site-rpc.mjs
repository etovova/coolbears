import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, readState } from '../devnet/core.mjs';
import { validateSiteRpcEndpoint } from '../devnet/deployment.mjs';
import { RpcError } from '../devnet/rpc.mjs';

const SITE_ORIGIN = 'https://coolbears-nfts.com';
const messages = Object.freeze({
  ARGUMENTS: 'Usage: node scripts/check-site-rpc.mjs --endpoint https://public-host/rpc',
  ENDPOINT: 'A public HTTPS /rpc endpoint without credentials, query or fragment is required.',
  CONFIG: 'The probe needs a fetch function and a timeout between 1 and 60000 milliseconds.',
  TIMEOUT: 'The read-only RPC probe exceeded its deadline.',
  NETWORK: 'The read-only RPC endpoint could not be reached.',
  HTTP: 'The RPC endpoint returned an unsuccessful HTTP response.',
  CORS: 'The RPC endpoint did not allow the exact CoolBears origin and required request/response headers.',
  METHOD: 'The probe attempted an unexpected RPC method.',
  GENESIS: 'The RPC endpoint is not Solana Devnet.',
  STATE: 'The expected finalized Devnet machine, guard and collection could not be verified.',
});
const failure = code => Object.assign(new Error(messages[code]), { code });
function bounded(promise, signal) {
  if (signal.aborted) return Promise.reject(failure('TIMEOUT'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(failure('TIMEOUT'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
const tokens = value => (value || '').split(',').map(part => part.trim().toLowerCase());

// Only OPTIONS and the two readState RPC methods are permitted. No wallet,
// simulation, balance query, signing, transaction submission or config writes.
export async function checkSiteRpc({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let url;
  try { url = validateSiteRpcEndpoint(endpoint); } catch { throw failure('ENDPOINT'); }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw failure('CONFIG');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let transportFailure, httpRequests = 0;
  async function fetchChecked(input, options) {
    let response;
    transportFailure = undefined;
    try {
      if (controller.signal.aborted) throw failure('TIMEOUT');
      if (input !== url || !['OPTIONS', 'POST'].includes(options.method)) throw failure('METHOD');
      if (options.method === 'POST') {
        const request = JSON.parse(options.body);
        if (!['getGenesisHash', 'getMultipleAccounts'].includes(request?.method)) throw failure('METHOD');
      }
      httpRequests++;
      response = await bounded(Promise.resolve().then(() => fetchImpl(url, {
        ...options, headers: { ...options.headers, origin: SITE_ORIGIN },
        signal: options.signal || controller.signal,
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      })), controller.signal);
      if (!response || response.redirected || (options.method === 'OPTIONS' && !response.ok)) throw failure('HTTP');
      if (response.headers.get('access-control-allow-origin') !== SITE_ORIGIN) throw failure('CORS');
      if (options.method === 'OPTIONS' && (
        !tokens(response.headers.get('access-control-allow-methods')).includes('post') ||
        !['content-type', 'solana-client'].every(header => tokens(response.headers.get('access-control-allow-headers')).includes(header))
      )) throw failure('CORS');
      if (options.method === 'POST' && !tokens(response.headers.get('access-control-expose-headers')).includes('retry-after')) throw failure('CORS');
      // Preserve the status and Retry-After for the existing bounded read
      // transport. A cold Durable Object can refuse its first read briefly.
      return response;
    } catch (error) {
      // Abort/cancel an untrusted error body instead of leaving its connection
      // open. Even a broken cancel implementation shares the probe deadline.
      try { if (response?.body) await bounded(response.body.cancel(), controller.signal); } catch { /* Report the fixed error below. */ }
      transportFailure = controller.signal.aborted ? failure('TIMEOUT') : Object.hasOwn(messages, error?.code) ? failure(error.code) : failure('NETWORK');
      // Invalid CORS/requests are terminal; do not let the read transport
      // mistake a plain validation exception for a retryable network error.
      throw new RpcError(transportFailure.code === 'NETWORK' ? 'NETWORK' : 'PROBE', transportFailure.message);
    }
  }
  try {
    return await bounded((async () => {
      const preflight = await fetchChecked(url, { method: 'OPTIONS', headers: {
        'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,solana-client',
      } });
      // Do not consume or export an OPTIONS body, including a stalled stream.
      if (preflight.body) await bounded(preflight.body.cancel(), controller.signal);
      const client = createClient(fetchChecked, {
        endpoint: url, signal: controller.signal, maxAttempts: 3,
        totalTimeoutMs: timeoutMs, attemptTimeoutMs: timeoutMs,
      });
      const state = await readState(client);
      return {
        ok: true, endpoint: url, cluster: 'devnet', readOnlyReady: true,
        itemsRedeemed: String(state.machine.itemsRedeemed),
        itemsAvailable: String(state.machine.data.itemsAvailable), httpRequests,
      };
    })(), controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw failure('TIMEOUT');
    if (transportFailure) throw transportFailure;
    if (error?.code === 'HTTP') throw failure('HTTP');
    if (error?.code === 'TIMEOUT') throw failure('TIMEOUT');
    throw failure(error?.message === 'Требуется Solana Devnet' ? 'GENESIS' : 'STATE');
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function runSiteRpcCli(args, { write = value => console.log(value), ...options } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--endpoint') throw failure('ARGUMENTS');
    const result = await checkSiteRpc({ ...options, endpoint: args[1] });
    write(JSON.stringify(result));
    return 0;
  } catch (error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'STATE';
    write(JSON.stringify({ ok: false, readOnlyReady: false, code, message: messages[code] }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runSiteRpcCli(process.argv.slice(2));
}
