// Loopback only. The bearer capability is delivered in the local URL fragment.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSigningSession } from './session.mjs';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const HEADERS = { 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
const need = (value, code) => { if (!value) throw Object.assign(Error('Request unavailable.'), { code }); };
async function readBody(req, limit = 4096) {
  need(!req.headers['content-encoding'] && req.headers['content-type'] === 'application/json', 'BODY');
  if (req.headers['content-length'] !== undefined) need(/^\d+$/.test(req.headers['content-length']) && +req.headers['content-length'] <= limit, 'BODY');
  const parts = []; let size = 0, timer;
  try {
    return await Promise.race([(async () => {
      for await (const chunk of req) { size += chunk.length; need(size <= limit, 'BODY'); parts.push(chunk); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    })(), new Promise((_, reject) => { timer = setTimeout(() => { reject(Object.assign(Error(), { code: 'BODY' })); req.destroy(); }, 4000); })]);
  } finally { clearTimeout(timer); }
}
function exact(value, fields) { return value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)); }
export async function startSigningConsole({ directory, endpoint, fetchImpl, timeoutMs, port = 8788,
  assetsDirectory = new URL('./build/', import.meta.url) } = {}) {
  need(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT');
  const session = await createSigningSession({ directory, endpoint, fetchImpl, timeoutMs });
  const assets = new Map();
  for (const [url, name, type] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8']])
    assets.set(url, { bytes: await readFile(new URL(name, assetsDirectory)), type });
  const token = randomBytes(32).toString('base64url'), digest = value => createHash('sha256').update(value).digest();
  const tokenHash = digest(`Bearer ${token}`);
  let origin;
  const server = createServer(async (req, res) => {
    const reply = (status, value, type = 'application/json; charset=utf-8') => {
      if (!res.destroyed) { res.writeHead(status, { ...HEADERS, connection: 'close', 'content-type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value); }
    };
    try {
      need(req.socket.remoteAddress === '127.0.0.1' && req.headers.host === new URL(origin).host, 'ORIGIN');
      need(!req.headers.cookie && !req.headers['x-forwarded-host'] && !req.headers.forwarded, 'ORIGIN');
      need(!req.headers.origin || req.headers.origin === origin, 'ORIGIN');
      need(!req.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'ORIGIN');
      need(!req.url.includes('?') && !req.url.includes('#'), 'ROUTE');
      if (req.method === 'GET' && assets.has(req.url)) { const asset = assets.get(req.url); return reply(200, asset.bytes, asset.type); }
      need(req.url.startsWith('/api/'), 'ROUTE');
      const auth = req.headers.authorization ?? '';
      need(typeof auth === 'string' && auth.length < 150 && timingSafeEqual(tokenHash, digest(auth)), 'AUTH');
      if (req.method === 'GET' && req.url === '/api/state') return reply(200, await session.state());
      need(req.method === 'POST' && req.headers.origin === origin, 'ORIGIN');
      const body = await readBody(req, req.url === '/api/group-signature' ? 8192 : 4096);
      if (req.url === '/api/check') { need(exact(body, ['requestId']), 'BODY'); return reply(200, await session.check(body.requestId)); }
      if (req.url === '/api/decline') { need(exact(body, ['requestId', 'claimId']), 'BODY'); return reply(200, await session.decline(body.requestId, body.claimId)); }
      if (req.url === '/api/signature') { need(exact(body, ['requestId', 'transactionBase64']), 'BODY'); return reply(200, await session.accept(body.requestId, body.transactionBase64)); }
      if (req.url === '/api/group-signature') { need(exact(body, ['requestId', 'transactionBase64s']), 'BODY'); return reply(200, await session.accept(body.requestId, body.transactionBase64s)); }
      need(false, 'ROUTE');
    } catch (error) {
      const allowed = ['AUTH', 'ORIGIN', 'ROUTE', 'BODY', 'REQUEST_CHANGED', 'BUSY', 'PREFLIGHT_BLOCKED', 'ALREADY_HANDLED', 'SIGNED_BYTES_CHANGED'];
      const code = allowed.includes(error.code) ? error.code : 'UNAVAILABLE';
      reply(code === 'AUTH' ? 401 : code === 'ORIGIN' ? 403 : code === 'ROUTE' ? 404 : code === 'BODY' ? 400 : 409,
        { ok: false, code, message: 'Signing request unavailable.' });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/#${token}`, origin,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
