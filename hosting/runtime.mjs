// Actual workerd asset routing, locally. No deployed endpoint or wallet.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { auditTree, hash, validateCandidate } from './audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, 'build/hosting-candidate');
const site = path.join(directory, 'site');
const configBytes = await readFile(path.join(directory, 'wrangler.json'));
const config = JSON.parse(configBytes), preparation = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
validateCandidate(config); assert.equal(hash(configBytes), preparation.configurationSha256);
assert.equal(preparation.status, 'prepared-locally');
// Reconstruct the exact approved inventory; never silently serve extra files.
const publicPaths = JSON.parse(await readFile(path.join(root, 'scripts/public-files.json'), 'utf8'));
const { hiddenFiles } = await import('../scripts/hidden-metadata.mjs');
const paths = [...publicPaths, ...hiddenFiles().map(x => x.path)];
const expected = new Map();
for (const file of paths) {
  const bytes = await readFile(path.join(root, file)); expected.set(file, { bytes: bytes.length, sha256: hash(bytes) });
}
const headerBytes = await readFile(path.join(root, 'hosting/headers.txt'));
expected.set('_headers', { bytes: headerBytes.length, sha256: hash(headerBytes) });
const inventory = await auditTree(site, expected);
assert.equal(inventory.summary.manifestSha256, preparation.candidate.manifestSha256);
const version = JSON.parse(await readFile(path.join(root, 'node_modules/miniflare/package.json'), 'utf8')).version;
const report = { version: 1, kind: 'local-hosting-runtime', startedAt: new Date().toISOString(), passed: false,
  engine: 'workerd', miniflareVersion: version, candidateManifestSha256: inventory.summary.manifestSha256,
  configurationSha256: hash(configBytes), deploymentPerformed: false, dnsChanged: false,
  liveTlsTested: false, realWalletTested: false, realTransactionsSent: 0, realRpcRequests: 0,
  salesOpen: false, cases: [], outboundRequests: 0, localUnreachableHarnessStub: true };
const errors = [], origin = 'https://coolbears-nfts.com'; let mf;
async function scenario(name, fn) {
  const detail = await fn(); report.cases.push({ name, passed: true, ...detail }); console.log('PASS ' + name);
}
async function get(file, options = {}) { return mf.dispatchFetch(origin + file, { redirect: 'manual', ...options }); }
async function expectFile(url, file, type) {
  const response = await get(url); assert.equal(response.status, 200);
  if (type) assert.match(response.headers.get('content-type') ?? '', type);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(body), expected.get(file).sha256, 'HTTP_BYTES_CHANGED');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  return response;
}
try {
  mf = new Miniflare({ telemetry: { enabled: false }, cf: false, logRequests: false,
    handleUncaughtError: error => errors.push(error.message),
    workers: [{ config: { name: config.name, compatibilityDate: config.compatibility_date,
      // Miniflare 5 requires a module even when no user Worker exists. Asset
      // routing must never invoke this test-only module; it is not in the bundle.
      manifest: { mainModule: 'unreachable.mjs', modules: { 'unreachable.mjs': {
        type: 'esm', contents: 'export default {fetch(){throw Error("UNEXPECTED_WORKER_INVOCATION")}}',
      } } },
      assets: { directory: site, hasUserWorker: false, htmlHandling: config.assets.html_handling,
        notFoundHandling: config.assets.not_found_handling, runWorkerFirst: config.assets.run_worker_first },
    }, dev: { outboundService: { type: 'fetcher', handler() { report.outboundRequests++; throw Error('HOSTING_OUTBOUND_FORBIDDEN'); } } } }],
  });
  await mf.ready;
  await scenario('root and Devnet directory use their existing HTML bytes', async () => {
    await expectFile('/', 'index.html', /text\/html/); await expectFile('/devnet/', 'devnet/index.html', /text\/html/);
    const redirect = await get('/devnet'); assert.equal(redirect.status, 307);
    assert.equal(new URL(redirect.headers.get('location'), origin).pathname, '/devnet/');
  });
  await scenario('all non-HTML public assets and legal pages retain their original bytes', async () => {
    let checked = 0;
    for (const file of publicPaths) {
      if (file.endsWith('.html')) {
        if (file === 'index.html' || file === 'devnet/index.html') continue;
        const redirect = await get('/' + file); assert.equal(redirect.status, 307);
        const target = new URL(redirect.headers.get('location'), origin);
        assert.equal(target.origin, origin); assert.equal(target.pathname, '/' + file.slice(0, -5));
        await expectFile(target.pathname, file, /text\/html/);
      } else {
        const type = /\.(mjs|js)$/.test(file) ? /javascript/ : file.endsWith('.css') ? /text\/css/
          : file.endsWith('.json') ? /application\/json/ : file.endsWith('.gif') ? /image\/gif/
            : file.endsWith('.png') ? /image\/png/ : file.endsWith('.webp') ? /image\/webp/ : undefined;
        await expectFile('/' + file, file, type);
      }
      checked++;
    }
    return { assetsChecked: checked };
  });
  await scenario('hidden metadata stays JSON with public read access and no SPA fallback', async () => {
    for (const index of ['0001', '0500', '5000', '9999']) {
      const file = `metadata/hidden/${index}.json`, response = await expectFile('/' + file, file, /application\/json/);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const data = JSON.parse(await readFile(path.join(site, file), 'utf8'));
      for (const field of ['attributes', 'rank', 'rarity', 'rarity_score']) assert.equal(Object.hasOwn(data, field), false);
      assert.equal(data.image, origin + '/assets/collection/gif.gif');
    }
    return { httpSamples: 4, metadataFilesAuditedBeforeServing: preparation.hiddenMetadataVerified };
  });
  await scenario('missing and private paths do not expose data or return the home page', async () => {
    for (const url of ['/missing.json', '/metadata/hidden/10000.json', '/operator/package.json',
      '/private/reveal.json', '/.git/config', '/_headers', '/wrangler.json', '/report.json']) {
      const response = await get(url); assert.equal(response.status, 404); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });
  await scenario('the static host contains no RPC or mint endpoint', async () => {
    for (const url of ['/rpc', '/api/mint']) {
      const response = await get(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.ok([404, 405].includes(response.status)); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });
  await scenario('configuration is not cached and HEAD/ETag do not alter media', async () => {
    const configResponse = await expectFile('/config.js', 'config.js', /javascript/);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    const file = '/assets/collection/gif.gif', response = await expectFile(file, file.slice(1), /image\/gif/);
    const etag = response.headers.get('etag'); assert.ok(etag);
    const cached = await get(file, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
    const head = await get(file, { method: 'HEAD' }); assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
  assert.deepEqual(errors, []); assert.equal(report.outboundRequests, 0); report.passed = true;
} catch (error) {
  report.failure = { code: error.code ?? error.name, message: String(error.message).slice(0, 300) }; throw error;
} finally {
  await mf?.dispose(); report.completedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log('COOLBEARS_HOSTING_RUNTIME=' + JSON.stringify(report));
