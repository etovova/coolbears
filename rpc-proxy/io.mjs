import { ProxyError, ORIGIN } from './policy.mjs';

export function responseHeaders(cors = true) {
  return {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', vary: 'Origin',
    ...(cors ? { 'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': 'Retry-After' } : {}),
  };
}
export function errorResponse(failure, id = null, cors = true) {
  const error = failure instanceof ProxyError ? failure : new ProxyError('INTERNAL', 503);
  const headers = responseHeaders(cors);
  if (error.retryAfter) headers['retry-after'] = String(error.retryAfter);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: {
    code: error.rpcCode ?? -32098, message: 'CoolBears Devnet RPC request unavailable.',
    data: {
      category: error.category,
      ...(error.category === 'UPSTREAM_HTTP' && Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 300 && error.upstreamStatus <= 599
        ? { upstreamStatus: error.upstreamStatus } : {}),
    },
  } }), { status: error.status, headers });
}
export function validateHttp(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/rpc' || url.search) throw new ProxyError('NOT_FOUND', 404);
  if (request.headers.get('origin') !== ORIGIN) throw new ProxyError('ORIGIN', 403);
  if (request.method === 'OPTIONS') {
    if (request.headers.get('access-control-request-method') !== 'POST') throw new ProxyError('METHOD', 405);
    const headers = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (headers.some(header => !['content-type', 'solana-client'].includes(header))) throw new ProxyError('HEADERS', 403);
    return new Response(null, { status: 204, headers: {
      ...responseHeaders(), 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, solana-client', 'access-control-max-age': '600',
    } });
  }
  if (request.method !== 'POST') throw new ProxyError('METHOD', 405);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) throw new ProxyError('CONTENT_TYPE', 415);
  if (request.headers.has('content-encoding')) throw new ProxyError('CONTENT_ENCODING', 415);
  return null;
}

export async function bounded(task, timeoutMs, parentSignal, category = 'TIMEOUT') {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  if (parentSignal?.aborted) cancel();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new ProxyError(category, category === 'REQUEST_TIMEOUT' ? 408 : 504));
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ProxyError(category, 504);
      return task(controller.signal);
    }), stopped]);
  } finally {
    clearTimeout(timer); parentSignal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', abort);
  }
}

export async function readJsonBody(message, maxBytes, signal, request = false) {
  const length = message.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ProxyError(request ? 'REQUEST_SIZE' : 'RESPONSE_SIZE', request ? 413 : 502);
  if (!message.body) throw new ProxyError(request ? 'INVALID_REQUEST' : 'UPSTREAM_RESPONSE', request ? 400 : 502);
  const reader = message.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* A deadline must not await cancellation. */ } };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ProxyError(request ? 'REQUEST_TIMEOUT' : 'UPSTREAM_TIMEOUT', request ? 408 : 504);
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ProxyError('INVALID_BODY', request ? 400 : 502);
      size += value.byteLength;
      if (size > maxBytes) throw new ProxyError(request ? 'REQUEST_SIZE' : 'RESPONSE_SIZE', request ? 413 : 502);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ProxyError(request ? 'INVALID_REQUEST' : 'UPSTREAM_RESPONSE', request ? 400 : 502); }
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    try { reader.releaseLock(); } catch { /* The underlying read may still be cancelling. */ }
  }
}
