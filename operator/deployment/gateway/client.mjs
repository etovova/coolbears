// Server-side bearer transport. Do not bundle in the website or wallet pages.
import { DeploymentRpcError } from '../rpc.mjs';
export function createGatewayFetch({ endpoint, token, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  let url;
  try {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\s\\?#]/.test(endpoint)) throw Error();
    url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.pathname !== '/rpc' || url.search || url.hash || url.username || url.password
      || url.href !== endpoint || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)
      || typeof fetchImpl !== 'function') throw Error();
  } catch { throw new DeploymentRpcError('CONFIGURATION'); }
  let tail = Promise.resolve(), pending = 0;
  return async (target, init) => {
    if (target !== url.href || init?.method !== 'POST' || pending >= 16) throw new DeploymentRpcError('CONFIGURATION');
    pending++;
    const operation = tail.then(async () => {
      if (init.signal?.aborted) throw new DeploymentRpcError('TIMEOUT');
      const headers = new Headers(init.headers);
      if (headers.has('authorization') || headers.has('origin') || headers.has('cookie')) throw new DeploymentRpcError('CONFIGURATION');
      headers.set('authorization', `Bearer ${token}`);
      return fetchImpl(url.href, { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    });
    tail = operation.then(() => {}, () => {});
    try { return await operation; } finally { pending--; }
  };
}
