import { ORIGIN, OBJECT_NAME, LAB, LIMITS, ProxyError, digest, validateRpcRequest, sanitizeRpcResponse } from './policy.mjs';
import { bounded, readJsonBody, validateHttp, errorResponse, responseHeaders } from './io.mjs';

const DAY = 86400000;
const ledgerKey = 'rate:v1';
const markerKey = signature => `send:${signature}`;
const json = data => new Response(JSON.stringify(data), { headers: responseHeaders() });
const seconds = milliseconds => Math.max(1, Math.ceil(milliseconds / 1000));
function dailyCap(env) {
  const raw = env.DAILY_CREDIT_CAP ?? String(LIMITS.dailyCredits);
  if (!/^[1-9]\d{0,4}$/.test(String(raw)) || Number(raw) > LIMITS.dailyCredits) throw new ProxyError('CONFIGURATION', 503);
  return Number(raw);
}
function secret(env) {
  if (typeof env.HELIUS_API_KEY !== 'string' || env.HELIUS_API_KEY.length < 8 || env.HELIUS_API_KEY.length > 256 || /\s/.test(env.HELIUS_API_KEY)) throw new ProxyError('CONFIGURATION', 503);
  return env.HELIUS_API_KEY;
}
function safeLedger(value, day) {
  if (value === undefined) return { day, credits: 0, nextAt: 0, nextSendAt: 0, simulationCount: 0 };
  if (!value || !['day', 'credits', 'nextAt', 'nextSendAt', 'simulationCount'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new ProxyError('STORAGE', 503);
  return value.day < day ? { ...value, day, credits: 0, simulationCount: 0 } : value;
}
function cooldown(value, now) {
  if (!value) return 1000;
  if (/^\d+$/.test(value.trim())) return Math.min(Number.MAX_SAFE_INTEGER - now, Math.max(1000, Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 1000;
}

export default {
  async fetch(request, env) {
    const cors = request.headers.get('origin') === ORIGIN;
    try {
      const preflight = validateHttp(request);
      if (preflight) return preflight;
      const length = request.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.requestBytes)) throw new ProxyError('REQUEST_SIZE', 413);
      const id = env.RPC_GATE.idFromName(OBJECT_NAME);
      // No object names, destinations or upstream headers come from clients.
      return await env.RPC_GATE.get(id).fetch(request);
    } catch (failure) { return errorResponse(failure, null, cors); }
  },
};

// SQLite-backed Durable Object. The asynchronous KV API is supported on this
// backend; every admission uses one durable storage.transaction, never a
// transactionSync callback with asynchronous work or a cross-request JS lock.
export class RpcGate {
  constructor(state, env, { fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, limits = {}, lab = LAB } = {}) {
    this.storage = state.storage; this.env = env; this.fetchImpl = fetchImpl; this.now = now; this.lab = lab;
    // Trusted constructor injection is only for offline tests. No HTTP or env
    // field can change the lab, timings, per-IP limits or upstream destination.
    this.limits = { ...LIMITS, ...limits };
    this.startupUntil = this.now() + this.limits.sendIntervalMs;
    this.checkedStartup = false;
    this.restoredLedger = false;
    this.nextDispatchAt = 0;
    this.nextSendDispatchAt = 0;
  }

  async admit(validated, ipKey) {
    const cap = dailyCap(this.env);
    const { request, send, cost } = validated;
    return this.storage.transaction(async tx => {
      // A duplicate never reserves another credit or touches the upstream.
      if (send) {
        const existing = await tx.get(markerKey(send.signature));
        if (existing) {
          if (existing.hash !== send.hash) throw new ProxyError('SEND_CONFLICT', 409);
          if (existing.state === 'accepted' && existing.signature === send.signature) return { duplicate: true };
          throw new ProxyError('SEND_ALREADY_ATTEMPTED', 409);
        }
      }
      const savedRate = await tx.get(ledgerKey), savedIp = await tx.get(ipKey);
      // Take the admission clock after storage reads, not when this request
      // entered a possibly contended transaction queue.
      const time = this.now(), day = Math.floor(time / DAY);
      if (!Number.isSafeInteger(time) || time < 0) throw new ProxyError('CLOCK', 503);
      if (!this.checkedStartup) {
        this.restoredLedger = savedRate !== undefined;
        this.checkedStartup = true;
      }
      // A restored object cannot know how late the previous instance actually
      // entered fetch after committing its timestamp. A short cold-start
      // admission pause closes that gap; duplicates need no network and were
      // handled above. No quota or send claim is written for this refusal.
      const rate = safeLedger(savedRate, day);
      const ip = safeLedger(savedIp, day);
      if (rate.credits + cost > cap || ip.credits + cost > this.limits.perIpDailyCredits) throw new ProxyError('DAILY_LIMIT', 429, { retryAfter: seconds((Math.max(day, rate.day) + 1) * DAY - time) });
      const simulate = request.method === 'simulateTransaction';
      if (simulate && (rate.simulationCount >= this.limits.dailySimulations || ip.simulationCount >= this.limits.perIpDailySimulations)) throw new ProxyError('SIMULATION_LIMIT', 429, { retryAfter: seconds((Math.max(day, rate.day) + 1) * DAY - time) });
      const next = Math.max(rate.nextAt, send ? rate.nextSendAt : 0, this.restoredLedger ? this.startupUntil : 0);
      if (time < next) throw new ProxyError('RATE_LIMIT', 429, { retryAfter: seconds(next - time) });
      const nextRate = { ...rate, credits: rate.credits + cost, simulationCount: rate.simulationCount + Number(simulate), nextAt: time + this.limits.startIntervalMs, nextSendAt: send ? time + this.limits.sendIntervalMs : rate.nextSendAt };
      const nextIp = { ...ip, credits: ip.credits + cost, simulationCount: ip.simulationCount + Number(simulate) };
      await tx.put(ledgerKey, nextRate);
      await tx.put(ipKey, nextIp);
      if (send) await tx.put(markerKey(send.signature), { signature: send.signature, hash: send.hash, state: 'unknown', createdAt: time });
      return { duplicate: false };
    });
  }

  async deferUpstream(retryAfter) {
    const now = this.now(), duration = cooldown(retryAfter, now);
    await this.storage.transaction(async tx => {
      const rate = safeLedger(await tx.get(ledgerKey), Math.floor(now / DAY));
      await tx.put(ledgerKey, { ...rate, nextAt: Math.max(rate.nextAt, Math.min(Number.MAX_SAFE_INTEGER, now + duration)) });
    });
    return seconds(duration);
  }

  dispatch(validated, target, options) {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0) throw new ProxyError('CLOCK', 503);
    const next = Math.max(this.nextDispatchAt, validated.send ? this.nextSendDispatchAt : 0);
    if (time < next) throw new ProxyError('RATE_LIMIT', 429, { retryAfter: seconds(next - time) });
    // No await separates the live-object guard from fetch. Even if two durable
    // admissions resume together after a slow commit, they cannot burst here.
    this.nextDispatchAt = time + this.limits.startIntervalMs;
    if (validated.send) this.nextSendDispatchAt = time + this.limits.sendIntervalMs;
    return this.fetchImpl(target, options);
  }

  async fetch(request) {
    let id = null;
    const cors = request.headers.get('origin') === ORIGIN;
    try {
      const preflight = validateHttp(request);
      if (preflight) return preflight;
      const validated = await bounded(async signal => {
        const data = await readJsonBody(request, this.limits.requestBytes, signal, true);
        const result = await validateRpcRequest(data, { lab: this.lab });
        id = result.request.id; return result;
      }, this.limits.requestTimeoutMs, request.signal, 'REQUEST_TIMEOUT');
      const apiKey = secret(this.env);
      // CF-Connecting-IP is assigned by Cloudflare at ingress. Missing values
      // share one conservative bucket; CORS is not treated as authentication.
      const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
      if (clientIp.length > 64) throw new ProxyError('INVALID_REQUEST');
      const ipKey = `ip:${await digest(new TextEncoder().encode(`${apiKey}\0${clientIp}`))}`;
      const admission = await this.admit(validated, ipKey);
      if (admission.duplicate) return json({ jsonrpc: '2.0', id, result: validated.send.signature });
      // Awaiting admission means the signature claim and quota reservation
      // are durable BEFORE the only outbound send/read request can begin.
      const target = new URL('https://devnet.helius-rpc.com/');
      target.searchParams.set('api-key', apiKey);
      const upstream = await bounded(async signal => {
        const response = await this.dispatch(validated, target.href, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validated.request), signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        });
        if (!response.ok) {
          let retryAfter;
          if (response.status === 429 || response.status === 503) retryAfter = await this.deferUpstream(response.headers.get('retry-after'));
          try { void response.body?.cancel()?.catch(() => {}); } catch { /* Do not await a failed body. */ }
          throw new ProxyError('UPSTREAM_HTTP', response.status === 429 ? 429 : 502, { retryAfter });
        }
        const data = await readJsonBody(response, this.limits.responseBytes, signal);
        return sanitizeRpcResponse(data, validated, { lab: this.lab });
      }, this.limits.upstreamTimeoutMs, request.signal, 'UPSTREAM_TIMEOUT');
      if (validated.send) {
        await this.storage.transaction(async tx => {
          const saved = await tx.get(markerKey(validated.send.signature));
          if (!saved || saved.hash !== validated.send.hash) throw new ProxyError('STORAGE', 503);
          await tx.put(markerKey(validated.send.signature), { ...saved, state: 'accepted' });
        });
      }
      return json(upstream);
    } catch (failure) { return errorResponse(failure, id, cors); }
  }
}
