// A separate private operator gateway. No imports from the deployed laboratory Worker.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequestValidator } from '../request-policy.mjs';
import { createDeploymentRpc, DeploymentRpcError, GENESIS_HASHES } from '../rpc.mjs';
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff' };
const KEY = 'operator-rpc-limits:v1', INTERVAL = 200, HOLD = 15000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
class GatewayError extends Error {
  constructor(category, status = 503, retryAfter) { super(category); Object.assign(this, { category, status, retryAfter }); }
}
const fail = (category, status, retryAfter) => { throw new GatewayError(category, status, retryAfter); };
function errorResponse(error, id = null) {
  const failure = error instanceof GatewayError ? error : new GatewayError('UNAVAILABLE');
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32098,
    message: 'Operator RPC request unavailable.', data: { category: failure.category } } }), {
    status: failure.status, headers: { ...HEADERS, ...(failure.retryAfter ? { 'retry-after': String(failure.retryAfter) } : {}) } });
}
function cap(value, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > maximum) fail('CONFIGURATION');
  return Number(value);
}
function authorize(request, env) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.pathname !== '/rpc' || /[?#]/.test(request.url)) fail('NOT_FOUND', 404);
  if (request.method !== 'POST') fail('METHOD', 405);
  // This credential belongs only in a private operator process, never browser JS.
  if (request.headers.has('origin') || request.headers.has('cookie')) fail('BROWSER_FORBIDDEN', 403);
  const token = env.OPERATOR_RPC_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) fail('CONFIGURATION');
  const supplied = request.headers.get('authorization') ?? '';
  const digest = value => createHash('sha256').update(value).digest();
  if (supplied.length > 140 || !timingSafeEqual(digest(supplied), digest(`Bearer ${token}`))) fail('AUTH', 401);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
    || request.headers.has('content-encoding')) fail('CONTENT_TYPE', 415);
  if (typeof env.HELIUS_API_KEY !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(env.HELIUS_API_KEY)) fail('CONFIGURATION');
}
async function requestBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) fail('REQUEST_SIZE', 413);
  if (!request.body) fail('REQUEST', 400);
  const reader = request.body.getReader(), deadline = performance.now() + 4000;
  let timer;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  try {
    return await Promise.race([(async () => {
      const bytes = new Uint8Array(8192); let size = 0;
      while (true) {
        if (performance.now() >= deadline || request.signal.aborted) fail('REQUEST_TIMEOUT', 408);
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || size + value.length > bytes.length) fail('REQUEST_SIZE', 413);
        bytes.set(value, size); size += value.length;
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
      catch { fail('REQUEST', 400); }
    })(), new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(new GatewayError('REQUEST_TIMEOUT', 408)); }, 4000); })]);
  } finally { clearTimeout(timer); cancel(); try { reader.releaseLock(); } catch {} }
}
function ledger(value, now) {
  const day = Math.floor(now / 86400000);
  if (value === undefined) return { version: 1, day, used: 0, simulations: 0, nextAt: 0, holdUntil: 0, cooldownUntil: 0 };
  if (!object(value) || Object.keys(value).sort().join(',') !== 'cooldownUntil,day,holdUntil,nextAt,simulations,used,version'
    || value.version !== 1 || !Object.values(value).every(integer) || value.simulations > value.used) fail('LEDGER');
  // Clock rollback does not grant another daily allowance.
  return day > value.day ? { ...value, day, used: 0, simulations: 0 } : { ...value };
}
function retrySeconds(value, now) {
  if (typeof value !== 'string') return 5;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.min(300, seconds)) : 5;
}

export function makeGateway(compiledPolicy) {
  // Private deploy-time configuration; there is no request-time policy registration API.
  const validate = createRequestValidator(compiledPolicy);
  class DeploymentGate {
    constructor(state, env, { fetchImpl = (...args) => globalThis.fetch(...args), clock = Date.now,
      pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
      this.storage = state.storage; this.env = env; this.fetchImpl = fetchImpl;
      this.clock = clock; this.pause = pause; this.busy = false; this.genesisVerified = false;
    }
    async reserve(method) {
      const daily = cap(this.env.DAILY_CREDIT_CAP, 20000, 5000), simulations = cap(this.env.DAILY_SIMULATION_CAP, 5000, 2000);
      // Paced starts support sequential client calls without forcing automatic retries.
      const initial = ledger(await this.storage.get(KEY), this.clock());
      const blockedUntil = Math.max(initial.holdUntil, initial.cooldownUntil);
      if (blockedUntil > this.clock()) fail('COOLDOWN', 429, Math.ceil((blockedUntil - this.clock()) / 1000));
      const wait = initial.nextAt - this.clock();
      if (wait > INTERVAL) fail('COOLDOWN', 429, Math.ceil(wait / 1000));
      if (wait > 0) await this.pause(wait);
      await this.storage.transaction(async tx => {
        const now = this.clock(), value = ledger(await tx.get(KEY), now);
        const until = Math.max(value.nextAt, value.holdUntil, value.cooldownUntil);
        if (until > now) fail('COOLDOWN', 429, Math.ceil((until - now) / 1000));
        if (value.used >= daily || (method === 'simulateTransaction' && value.simulations >= simulations)) fail('DAILY_LIMIT', 429, Math.max(1, Math.ceil(((value.day + 1) * 86400000 - now) / 1000)));
        value.used++; if (method === 'simulateTransaction') value.simulations++;
        // Charge before any network I/O. A crash retains a conservative hold; no refunds.
        value.nextAt = now + INTERVAL; value.holdUntil = now + HOLD;
        await tx.put(KEY, value);
      });
    }
    async upstream(method, params) {
      await this.reserve(method);
      let cooldown = 0, status;
      const endpoint = new URL('https://devnet.helius-rpc.com/');
      endpoint.searchParams.set('api-key', this.env.HELIUS_API_KEY);
      const rpc = createDeploymentRpc({ endpoint: endpoint.href, allowSimulation: true, timeoutMs: 12000,
        fetchImpl: async (url, init) => {
          // workerd accepts manual redirects; the transport rejects every 3xx.
          const response = await this.fetchImpl(url, { ...init, redirect: 'manual' }); status = response.status;
          if ([429, 503].includes(status)) cooldown = retrySeconds(response.headers.get('retry-after'), this.clock());
          return response;
        } });
      try { return await rpc.call(method, params); }
      catch (error) {
        if (error instanceof DeploymentRpcError) {
          if (error.code === 'HTTP' && [429, 503].includes(status)) throw new GatewayError('UPSTREAM_HTTP', status, cooldown);
          throw new GatewayError(`UPSTREAM_${error.code}`, error.code === 'TIMEOUT' ? 504 : 502);
        }
        throw error;
      } finally {
        await this.storage.transaction(async tx => {
          const now = this.clock(), value = ledger(await tx.get(KEY), now);
          value.holdUntil = 0; value.nextAt = Math.max(value.nextAt, now + INTERVAL);
          value.cooldownUntil = Math.max(value.cooldownUntil, now + cooldown * 1000);
          await tx.put(KEY, value);
        });
      }
    }
    async fetch(request) {
      let id = null, ownsBusy = false;
      try {
        authorize(request, this.env);
        if (this.busy) fail('BUSY', 429, 1);
        this.busy = true; ownsBusy = true;
        const body = await requestBody(request);
        if (!object(body) || Object.keys(body).sort().join(',') !== 'id,jsonrpc,method,params'
          || body.jsonrpc !== '2.0' || !integer(body.id) || body.id < 1) fail('REQUEST', 400);
        id = body.id;
        try { validate(body.method, body.params); } catch { fail('POLICY', 400); }
        let result;
        if (!this.genesisVerified || body.method === 'getGenesisHash') {
          this.genesisVerified = false;
          result = await this.upstream('getGenesisHash', []);
          if (result !== GENESIS_HASHES.devnet) fail('GENESIS', 502);
          this.genesisVerified = true;
        }
        if (body.method !== 'getGenesisHash') result = await this.upstream(body.method, body.params);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: HEADERS });
      } catch (error) { return errorResponse(error, id); }
      finally { if (ownsBusy) this.busy = false; }
    }
  }
  const worker = { async fetch(request, env) {
    try {
      authorize(request, env);
      return await env.DEPLOYMENT_GATE.get(env.DEPLOYMENT_GATE.idFromName('closed-devnet-operator-v1')).fetch(request);
    } catch (error) { return errorResponse(error); }
  } };
  return { worker, DeploymentGate };
}
