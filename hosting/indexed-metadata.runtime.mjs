// Actual workerd HTTP, static assets and bundled metadata Worker. No deployment.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { policy } from '../scripts/hidden-metadata.mjs';
import { canonicalRevealJson } from '../operator/reveal/model.mjs';
import { final, hidden, proofBody, releaseOptions } from './indexed-metadata.fixture.mjs';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const prepared = path.join(root, 'build/hidden-hosting-candidate');
const config = JSON.parse(await readFile(path.join(prepared, 'wrangler.json')));
assert.equal(config.assets.run_worker_first, true); assert.equal(config.vars.METADATA_REVEAL, 'closed');
const contents = await readFile(path.join(prepared, 'worker.mjs'), 'utf8');
const errors = [], cases = [];
let outboundRequests = 0, mf;
const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-indexed-runtime-'));
const request = (route, options) => mf.dispatchFetch(policy.website + route, { redirect: 'manual', ...options });
async function start(script, site, vars = {}) {
  mf = new Miniflare({ telemetry: { enabled: false }, cf: false, logRequests: false,
    handleUncaughtError: error => errors.push(error.message),
    workers: [{ config: { name: 'coolbears-indexed-runtime', compatibilityDate: config.compatibility_date,
      env: { ASSETS: { type: 'assets' }, ...Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, { type: 'text', value }])) },
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: script } } },
      assets: { directory: site, hasUserWorker: true, htmlHandling: 'auto-trailing-slash', notFoundHandling: 'none', runWorkerFirst: true } },
      dev: { outboundService: { type: 'fetcher', handler() { outboundRequests++; throw Error('EXTERNAL_REQUEST_FORBIDDEN'); } } } }] });
  await mf.ready;
}
try {
  await start(contents, path.join(prepared, 'site'), config.vars);
  for (const i of [1, 9, 10, 99, 100, 999, 1000, 5000, 9999]) {
    const result = await request(`/metadata/hidden-indexed/${i}.json`);
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), hidden[i]);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
  }
  cases.push('nine exact approved indexed placeholders across decimal width boundaries through bundled workerd/static ASSETS');
  for (const route of ['/metadata/hidden-indexed/0.json', '/metadata/hidden-indexed/0001.json',
    '/metadata/hidden-indexed/10000.json', '/metadata/hidden-indexed/%31.json',
    '/metadata/%68idden/0001.json', '/metad%61ta/hidden/0001.json', '/metadata//hidden/0001.json',
    '//metadata/hidden/0001.json', '/metadata/hidden-indexed/1.json?reveal=true', '/metadata/reveal-proof.json']) {
    assert.equal((await request(route)).status, 404, route);
  }
  cases.push('encoded/slash/query/internal aliases and release proof cannot bypass the closed metadata Worker');
  assert.equal((await request('/metadata/hidden-indexed/1.json', { method: 'POST' })).status, 405);
  const head = await request('/metadata/hidden-indexed/1.json', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const siteConfig = await request('/config.js'); assert.equal(siteConfig.status, 200);
  assert.equal(siteConfig.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/assets/collection/gif.gif')).status, 200);
  assert.equal((await request('/private/reveal.json')).status, 404);
  cases.push('GET/HEAD/read-only methods, original assets, no-store configuration and private-path 404 preserved');
  await mf.dispose(); mf = null;

  // Disposable final content uses example.invalid URLs; none is a real bear.
  const site = path.join(parent, 'site'); await mkdir(path.join(site, 'metadata/hidden'), { recursive: true });
  await writeFile(path.join(site, 'metadata/reveal-proof.json'), proofBody);
  for (const i of [0, 1, 1000, 9999]) await writeFile(path.join(site, `metadata/hidden/${String(i).padStart(4, '0')}.json`), canonicalRevealJson(i ? final[i] : hidden[i]));
  // Replace the constructor input with an explicit synthetic clock, not the
  // system clock or a production activation path.
  const fixtureSource = `import { createIndexedMetadataWorker } from './hosting/indexed-metadata-worker.mjs';
export default createIndexedMetadataWorker({...${JSON.stringify({ ...releaseOptions, now: undefined })},now:()=>Date.parse('2027-01-02T00:00:00.000Z')});`;
  const released = await build({ stdin: { contents: fixtureSource, resolveDir: root, sourcefile: 'release-fixture.mjs' },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
  await start(released.outputFiles[0].text, site);
  for (const i of [1, 1000, 9999]) {
    const result = await request(`/metadata/hidden-indexed/${i}.json`); assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), final[i]);
  }
  assert.equal((await request('/metadata/hidden/0000.json')).status, 200);
  assert.equal(await (await request('/metadata/reveal-proof.json')).text(), proofBody);
  cases.push('authorized future-clock synthetic final JSON passes exact committed content hashes at the same URIs; internal placeholder stays hidden');
  await writeFile(path.join(site, 'metadata/hidden/0001.json'), canonicalRevealJson({ ...final[1], image: 'https://example.invalid/tampered.png' }));
  // Restart removes runtime/asset caches; tampered data must still fail closed.
  await mf.dispose(); mf = null; await start(released.outputFiles[0].text, site);
  assert.equal((await request('/metadata/hidden-indexed/1.json')).status, 503);
  cases.push('full workerd restart rejects a substituted final document');
  assert.deepEqual(errors, []); assert.equal(outboundRequests, 0);
  const report = { passed: true, engine: 'workerd', cases, outboundRequests, deploymentPerformed: false,
    realTransactionsSent: 0, realWallets: false, marketplaceRefreshVerified: false,
    cloudflareCpuAndRequestQuotasVerified: false, finalContentIsDisposableFixture: true };
  await writeFile(path.join(prepared, 'indexed-runtime.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally { await mf?.dispose(); await rm(parent, { recursive: true, force: true }); }
