// Offline audit of a NEW, unsubmitted CLI preparation. Never signs or calls RPC.
// Only the approved site's metadata base is accepted. Other destinations need
// a separate review. Deployment journals/caches must never be reset for this check.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePreparation, policy } from './prepare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function verifyPreparation(directory) {
  assert.ok(directory, 'Specify a preparation directory');
  const source = path.resolve(directory);
  const readJson = async file => JSON.parse(await readFile(path.join(source, file), 'utf8'));
  const config = await readJson('cm-config.json');
  // A supplied address is checked for syntax only; no existence/authority claim.
  const expected = makePreparation({ collection: config?.config?.collection });
  const compare = (actual, approved, file) => {
    // Do not dump arbitrary input values (including accidentally pasted secrets).
    try { assert.deepEqual(actual, approved); }
    catch { throw Error(`Preparation mismatch: ${file}`); }
  };
  compare(config, expected.cmConfig, 'cm-config.json');
  compare(await readJson('asset-cache.json'), expected.assetCache, 'asset-cache.json');
  compare(await readJson('collection-plugins.json'), expected.plugins, 'collection-plugins.json');
  compare(await readJson('release-plan.json'), expected.releasePlan, 'release-plan.json');
  compare(await readJson('collection.json'), JSON.parse(await readFile(path.join(root, 'metadata/collection.json'), 'utf8')), 'collection.json');
  compare(await readJson('preparation.json'), {
    stage: 'prepared-offline', cliVersion: '0.4.3', cluster: 'devnet',
    supply: policy.supply, machineItems: policy.supply - 1,
    metadataPublished: false, collectionCreated: false, machineCreated: false,
    salesOpen: false, earliestRevealDate: policy.earliestRevealDate,
  }, 'preparation.json');
  const filenames = expected.documents.map((_, index) => `${String(index).padStart(4, '0')}.json`);
  compare((await readdir(path.join(source, 'hidden'))).sort(), filenames, 'hidden filenames');
  const digest = createHash('sha256');
  for (const [index, filename] of filenames.entries()) {
    const relative = `hidden/${filename}`;
    const document = await readJson(relative);
    compare(document, expected.documents[index], relative);
    // Cross-check the actual repository files too, not only the generator.
    compare(JSON.parse(await readFile(path.join(root, 'metadata', relative), 'utf8')), document, `repository metadata/${relative}`);
    digest.update(`${filename}\0${JSON.stringify(expected.documents[index])}\n`);
  }
  return {
    version: 1, status: 'offline-preparation-verified',
    metadataDocuments: filenames.length, machineItems: expected.cmConfig.config.itemsAvailable,
    hiddenMetadataSha256: digest.digest('hex'),
    reservedIndex: 0, reservedOwner: policy.owner, reservedAssetCreated: false,
    priceLamports: expected.releasePlan.payment.lamports, royaltyBasisPoints: expected.releasePlan.royalties.basisPoints,
    maxPerOrder: policy.maxPerOrder, earliestRevealDate: policy.earliestRevealDate,
    collectionAddressProvided: !!expected.cmConfig.config.collection,
    networkRequests: 0, transactionsSent: 0, salesOpen: false, readyToDeploy: false,
    unverified: ['network and funding', 'collection existence and authorities', 'reserved asset creation',
      'machine creation and insertion', 'production RPC and order recovery', 'private reveal mapping'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyPreparation(process.argv[2]), null, 2)); }
  catch {
    // Malformed JSON/URLs can contain secrets: keep command output generic.
    console.error('Offline preparation check failed. Use a fresh prepared directory and review its files; do not reset an existing deployment.');
    process.exitCode = 1;
  }
}
