// Separate static+alias candidate; no deployment, DNS, RPC, signing or sends.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { hiddenFiles, verifyHiddenFiles, policy } from '../scripts/hidden-metadata.mjs';
import { prepareRevealPayload } from '../operator/reveal/model.mjs';
import { auditTree, readRegular, hash } from './audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function prepareIndexedHostingCandidate({ output = path.join(root, 'build/hidden-hosting-candidate'), reveal = null } = {}) {
  assert.ok(path.isAbsolute(output), 'OUTPUT_MUST_BE_ABSOLUTE');
  const publicFiles = JSON.parse(await readFile(path.join(root, 'scripts/public-files.json'), 'utf8'));
  const files = [...publicFiles, ...hiddenFiles().map(x => x.path)];
  assert.equal(new Set(files).size, files.length);
  await verifyHiddenFiles(root); await verifyHiddenFiles(path.join(root, 'public-site'));
  const expected = new Map();
  for (const file of files) {
    const bytes = await readRegular(root, file); expected.set(file, { bytes: bytes.length, sha256: hash(bytes) });
  }
  await auditTree(path.join(root, 'public-site'), expected);
  const scope = { window: {}, document: { addEventListener() {} } };
  runInNewContext(await readFile(path.join(root, 'public-site/config.js'), 'utf8'), scope, { timeout: 100 });
  const config = scope.window.COOLBEARS_CONFIG;
  assert.ok(config.demoMode === true && config.cluster === 'devnet' && config.collectionAddress === ''
    && config.candyMachineAddress === '' && config.priceSol === policy.priceSol, 'SALES_NOT_CLOSED');
  for (const kind of ['logo', 'banner', 'gif']) {
    assert.equal(expected.get(`assets/collection/${kind}.${kind === 'gif' ? 'gif' : 'png'}`).sha256,
      policy.publicAssets[kind].sha256, 'ORIGINAL_ASSET_CHANGED');
  }
  // Any final content requires explicit private inputs and the complete offline
  // time, authorization, commitment and original artwork verification gates.
  const release = reveal === null ? null : await prepareRevealPayload(reveal.manifest, reveal);
  const replacement = new Map(release?.files.map(file => [file.path, file.body]) ?? []);
  const vars = release ? { METADATA_REVEAL: 'authorized', REVEAL_COMMITMENT_SHA256: release.commitmentSha256,
    REVEAL_PROOF_SHA256: release.proofSha256 } : { METADATA_REVEAL: 'closed' };
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const site = path.join(output, 'site');
  for (const file of files) {
    const bytes = replacement.has(file) ? Buffer.from(replacement.get(file)) : await readRegular(path.join(root, 'public-site'), file);
    if (!replacement.has(file)) assert.equal(hash(bytes), expected.get(file).sha256, 'SOURCE_CHANGED');
    expected.set(file, { bytes: bytes.length, sha256: hash(bytes) });
    const target = path.join(site, file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  const headers = await readFile(new URL('./headers.txt', import.meta.url));
  await writeFile(path.join(site, '_headers'), headers, { flag: 'wx' });
  expected.set('_headers', { bytes: headers.length, sha256: hash(headers) });
  if (release) {
    await writeFile(path.join(site, 'metadata/reveal-proof.json'), release.proofBody, { flag: 'wx' });
    expected.set('metadata/reveal-proof.json', { bytes: Buffer.byteLength(release.proofBody), sha256: release.proofSha256 });
  }
  const inventory = await auditTree(site, expected);
  const worker = await build({ entryPoints: [path.join(root, 'hosting/indexed-metadata-worker.mjs')],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, minify: true,
    legalComments: 'none' });
  assert.equal(worker.outputFiles.length, 1); const workerBytes = worker.outputFiles[0].contents;
  assert.ok(workerBytes.length < 3 * 1024 * 1024, 'FREE_WORKER_BUNDLE_LIMIT');
  await writeFile(path.join(output, 'worker.mjs'), workerBytes, { flag: 'wx' });
  const wrangler = { name: 'coolbears-site-hidden-candidate', main: './worker.mjs', compatibility_date: '2026-09-23',
    workers_dev: false, preview_urls: false, vars,
    assets: { directory: './site', binding: 'ASSETS', html_handling: 'auto-trailing-slash',
      // Inspect every request so percent-encoded path aliases cannot bypass
      // metadata privacy checks in the static router.
      not_found_handling: 'none', run_worker_first: true },
    observability: { enabled: false } };
  await writeFile(path.join(output, 'wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n', { flag: 'wx' });
  const report = { version: 1, kind: 'hidden-settings-hosting-candidate', status: 'prepared-locally',
    metadataMode: release ? 'authorized-reveal' : 'hidden', inventory: inventory.summary,
    publicItems: policy.supply - 1, indexedAliases: policy.supply - 1, additionalIndexedAssetFiles: 0,
    publicOriginalMediaVerified: true, oldPublicPathsPreserved: true,
    workerBytes: workerBytes.length, workerSha256: hash(workerBytes),
    workerFreeRequestAndCpuLimitsVerified: false, accountInvoicesVerified: false,
    deploymentPerformed: false, dnsChanged: false, realRpcRequests: 0, realTransactionsSent: 0,
    salesOpen: false, priceSol: policy.priceSol, readyForDeployment: false,
    commitmentSha256: release?.commitmentSha256 ?? null, finalArtworkBytesVerified: release !== null,
    finalImageAvailabilityVerified: false, marketplaceRefreshVerified: false,
    onchainPublicRevealTransactions: 0,
    remaining: ['Private inputs and custody', 'Fresh selected-network account and fee checks',
      'Real wallet and phone checks', 'Separately authorized deployment', 'Actual hosting/storage/domain usage'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { output, report };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareIndexedHostingCandidate(); console.log(JSON.stringify(result.report));
}
