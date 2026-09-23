// Read-only checks of the deployed static candidate. No wallet or RPC requests.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { hash } from './audit.mjs';
import { edgeRequest } from './edge-request.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'build/hosting-candidate');
const target = process.argv[2] ?? '--staging';
assert.ok(process.argv.length <= 3 && ['--staging', '--production'].includes(target), 'Use --staging or --production');
const production = target === '--production';
const edgeIp = process.env.COOLBEARS_EDGE_IP;
assert.ok(!edgeIp || production, 'Edge diagnostics are only for the approved main domain');
const origin = production ? 'https://coolbears-nfts.com' : 'https://coolbears-site-candidate.yauheni84.workers.dev';
const bundle = JSON.parse(await readFile(path.join(directory, 'direct-upload.json')));
const entries = new Map(bundle.entries.map(e => [e.path, e]));
const publicFiles = JSON.parse(await readFile(path.join(root, 'scripts/public-files.json')));
const report = { kind: production ? 'live-cloudflare-static-production' : 'live-cloudflare-static-staging', startedAt: new Date().toISOString(), origin,
  sourceCommit: bundle.sourceCommit, candidateManifestSha256: bundle.candidateManifestSha256,
  connectionOverride: edgeIp ?? null, publicDnsRouteTested: !edgeIp,
  passed: false, checks: [], salesOpen: false, priceSol: 0.2,
  realWalletTested: false, realRpcRequests: 0, realTransactionsSent: 0, mainDomainSwitched: false };
const failures = [];
async function request(url, options = {}) {
  if (edgeIp) return edgeRequest(origin + url, edgeIp, options);
  const response = await fetch(origin + url, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...options });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}
async function check(name, fn) {
  try { const result = await fn(); report.checks.push({ name, passed: true, ...result }); }
  catch (error) { failures.push(name); report.checks.push({ name, passed: false, error: error.message.slice(0, 250) }); }
}
async function checkFile(file) {
  let url = '/' + file;
  if (file === 'index.html') url = '/';
  else if (file === 'devnet/index.html') url = '/devnet/';
  else if (file.endsWith('.html')) {
    const redirect = await request(url); assert.equal(redirect.response.status, 307);
    const target = new URL(redirect.response.headers.get('location'), origin);
    assert.equal(target.origin, origin); assert.equal(target.pathname, '/' + file.slice(0, -5));
    url = target.pathname;
  }
  const { response, body } = await request(url), expected = entries.get(file);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('server'), 'cloudflare');
  assert.equal(hash(body), expected.sha256, 'HTTP_BYTES_CHANGED');
  assert.equal(response.headers.get('content-type').split(';')[0], expected.type.split(';')[0]);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  if (file.startsWith('metadata/')) assert.equal(response.headers.get('access-control-allow-origin'), '*');
  if (file === 'config.js') {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const scope = { window: {}, document: { addEventListener() {} } };
    runInNewContext(body.toString(), scope, { timeout: 100 });
    const config = scope.window.COOLBEARS_CONFIG;
    assert.equal(config.priceSol, 0.2); assert.equal(config.demoMode, true);
    assert.equal(config.cluster, 'devnet'); assert.equal(config.collectionAddress, '');
    assert.equal(config.candyMachineAddress, '');
  }
  return { path: url, status: response.status, bytes: body.length, sha256: expected.sha256 };
}
const paths = [...publicFiles, 'metadata/hidden/0000.json', 'metadata/hidden/0001.json',
  'metadata/hidden/4999.json', 'metadata/hidden/9999.json'];
// Four bounded simultaneous GETs; no load testing.
for (let i = 0; i < paths.length; i += 4) {
  await Promise.all(paths.slice(i, i + 4).map(file => check('bytes ' + file, () => checkFile(file))));
}
await check('directory redirect', async () => {
  const { response } = await request('/devnet'); assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get('location'), origin).pathname, '/devnet/');
});
for (const url of ['/missing.json', '/metadata/hidden/10000.json', '/operator/package.json', '/private/reveal.json',
  '/.git/config', '/_headers', '/wrangler.json', '/report.json']) {
  await check('not served ' + url, async () => {
    const { response, body } = await request(url); assert.equal(response.status, 404); assert.equal(body.length, 0);
  });
}
for (const url of ['/rpc', '/api/mint']) {
  await check('no endpoint ' + url, async () => {
    const { response, body } = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok([404,405].includes(response.status)); assert.equal(body.length, 0);
  });
}
await check('GIF HEAD and ETag', async () => {
  const first = await request('/assets/collection/gif.gif');
  const etag = first.response.headers.get('etag'); assert.ok(etag);
  const cached = await request('/assets/collection/gif.gif', { headers: { 'if-none-match': etag } });
  assert.equal(cached.response.status, 304); assert.equal(cached.body.length, 0);
  const head = await request('/assets/collection/gif.gif', { method: 'HEAD' });
  assert.equal(head.response.status, 200); assert.equal(head.body.length, 0);
});
report.passed = failures.length === 0;
report.mainDomainSwitched = production && !edgeIp && report.passed;
report.completedAt = new Date().toISOString();
await writeFile(path.join(directory, production ? (edgeIp ? 'live-production-edge.json' : 'live-production.json') : 'live-staging.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures, origin }));
if (!report.passed) process.exitCode = 1;
