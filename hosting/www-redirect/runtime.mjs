// Validate the assets-only redirect before connecting www. No network or wallet.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
const origin = 'https://www.coolbears-nfts.com';
let outboundRequests = 0;
const mf = new Miniflare({ telemetry: { enabled: false }, cf: false, logRequests: false,
  workers: [{ config: { name: 'coolbears-www-redirect', compatibilityDate: '2026-09-23',
    manifest: { mainModule: 'unreachable.mjs', modules: { 'unreachable.mjs': {
      type: 'esm', contents: 'export default {fetch(){throw Error("UNEXPECTED_WORKER_INVOCATION")}}',
    } } },
    assets: { directory: fileURLToPath(new URL('./site', import.meta.url)), hasUserWorker: false,
      htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: false },
  }, dev: { outboundService: { type: 'fetcher', handler() {
    outboundRequests++; throw Error('UNEXPECTED_OUTBOUND');
  } } } }],
});
const cases = [
  ['GET', '/'], ['GET', '/devnet/?via=www&value=a%2Fb'],
  ['GET', '/metadata/hidden/0001.json'], ['HEAD', '/assets/collection/gif.gif'],
  ['GET', '//example.org/path?q=1'], ['GET', '/_redirects'],
];
try {
  await mf.ready;
  for (const [method, suffix] of cases) {
    const response = await mf.dispatchFetch(origin + suffix, { method, redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), 'https://coolbears-nfts.com' + suffix);
  }
  assert.equal(outboundRequests, 0);
  console.log(JSON.stringify({ passed: true, cases: cases.length, outboundRequests, userWorker: false }));
} finally { await mf.dispose(); }
