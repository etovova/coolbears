// Prepare a separate reviewable candidate. Never change the published site.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { hiddenFiles, verifyHiddenFiles, policy } from '../scripts/hidden-metadata.mjs';
import { deploymentRpc } from '../devnet/deployment.mjs';
import { ORIGIN } from '../rpc-proxy/policy.mjs';
import { auditTree, readRegular, hash, validateCandidate } from './audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'build/hosting-candidate');
const configBytes = await readFile(new URL('./candidate.json', import.meta.url));
validateCandidate(JSON.parse(configBytes));
const publicFiles = JSON.parse(await readFile(path.join(root, 'scripts/public-files.json'), 'utf8'));
const hidden = hiddenFiles(), paths = [...publicFiles, ...hidden.map(x => x.path)].sort();
assert.equal(new Set(paths).size, paths.length, 'DUPLICATE_PUBLIC_PATH');
const expected = new Map();
for (const file of paths) {
  const bytes = await readRegular(root, file);
  expected.set(file, { bytes: bytes.length, sha256: hash(bytes) });
}
await verifyHiddenFiles(); await verifyHiddenFiles(path.join(root, 'public-site'));
const source = await auditTree(path.join(root, 'public-site'), expected);
const scope = { window: {}, document: { addEventListener() {} } };
runInNewContext(await readFile(path.join(root, 'public-site/config.js'), 'utf8'), scope, { timeout: 100 });
const site = scope.window.COOLBEARS_CONFIG;
assert.ok(site.demoMode === true && site.cluster === 'devnet' && site.collectionAddress === '' && site.candyMachineAddress === '', 'SALES_NOT_CLOSED');
assert.equal(site.priceSol, policy.priceSol); assert.equal(site.priceSol, 0.2);
assert.equal(site.officialWebsite, policy.website); assert.equal(ORIGIN, policy.website);
const rpc = deploymentRpc(); // Validate existing public relay; make no request.
for (const kind of ['logo', 'banner', 'gif']) {
  const file = `assets/collection/${kind}.${kind === 'gif' ? 'gif' : 'png'}`;
  assert.equal(expected.get(file).sha256, policy.publicAssets[kind].sha256, 'ORIGINAL_ASSET_CHANGED');
}
// Exclusive directory creation preserves every earlier candidate/checkpoint.
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
for (const file of paths) {
  const bytes = await readRegular(path.join(root, 'public-site'), file);
  assert.equal(hash(bytes), expected.get(file).sha256, 'SOURCE_CHANGED_DURING_COPY');
  const destination = path.join(output, 'site', file);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' });
}
const headers = await readFile(new URL('./headers.txt', import.meta.url));
await writeFile(path.join(output, 'site/_headers'), headers, { flag: 'wx' });
expected.set('_headers', { bytes: headers.length, sha256: hash(headers) });
const candidate = await auditTree(path.join(output, 'site'), expected);
await writeFile(path.join(output, 'wrangler.json'), configBytes, { flag: 'wx' });
const report = { version: 1, kind: 'hosting-candidate-preparation', status: 'prepared-locally',
  checkedAt: new Date().toISOString(), providerCandidate: 'Cloudflare Workers Static Assets',
  source: source.summary, candidate: candidate.summary, hiddenMetadataVerified: hidden.length,
  existingPublicFileBytesUnchanged: true, originalMediaVerified: true, extraControlFiles: ['_headers'],
  configurationSha256: hash(configBytes), allSourcePathsFromApprovedAllowlist: true,
  salesOpen: false, priceSol: site.priceSol, publicOrigin: policy.website,
  rpcEndpointUnchanged: true, rpcKind: rpc.kind, rpcAcceptsSameOrigin: true,
  publicPreviewOriginAcceptedByRpc: false, productionRpcReady: false,
  userWorkerScriptIncluded: false, routesConfigured: false, publicPreviewEnabled: false,
  deploymentPerformed: false, dnsChanged: false, walletUsed: false, realTransactionsSent: 0,
  referenceStaticHostingMonthlyUsd: '0.00', actualAccountBillUsd: null,
  freePlanFitIsConditionalOnUnchangedLimitsAndStaticOnlyRouting: true,
  domainAndRpcAndFinalStorageIncluded: false, readyForDeployment: false,
  remaining: ['Owner hosting decision', 'Cloudflare zone/account eligibility and existing DNS records',
    'Actual deployment, TLS and domain routing verification', 'Actual account invoices and final storage usage',
    'Production mint RPC path remains a separate unfinished stage'] };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('COOLBEARS_HOSTING_PREPARATION=' + JSON.stringify(report));
