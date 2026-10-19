import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKey } from '@metaplex-foundation/umi';
import { hiddenDocuments, policy } from '../scripts/hidden-metadata.mjs';
import { resolveStorageProfile, HIDDEN_SETTINGS, hiddenSettingsForSdk } from './storage-mode.mjs';

export { policy };

const root = fileURLToPath(new URL('../', import.meta.url));

export function makePreparation({ collection = '', metadataBase, storageMode, hiddenCommitmentSha256 } = {}) {
  assert.equal(policy.supply, 10000);
  assert.equal(policy.priceSol, 0.2);
  assert.equal(policy.royaltyPercent, 7);
  publicKey(policy.owner);
  assert.equal(typeof collection, 'string', 'Collection must be a public-key string or an empty string');
  if (collection) publicKey(collection);
  const profile = resolveStorageProfile(policy, { storageMode, hiddenCommitmentSha256 });
  const hidden = profile.storageMode === HIDDEN_SETTINGS;
  assert.ok(!hidden || metadataBase === undefined, 'Hidden settings require the approved indexed metadata endpoint');
  const base = new URL(metadataBase ?? `${policy.website}/metadata/hidden/`);
  assert.equal(base.protocol, 'https:', 'Metadata must use HTTPS');
  assert.ok(base.pathname.endsWith('/') && !base.search && !base.hash && !base.username && !base.password, 'Use a directory URL without credentials, query or fragment');
  const documents = hiddenDocuments().map(document => {
    assert.equal(Buffer.byteLength(document.name, 'utf8') <= 32, true);
    for (const field of ['attributes', 'rank', 'rarity', 'rarity_score']) assert.ok(!(field in document));
    return document;
  });
  const legacyAssetItems = Object.fromEntries(documents.slice(1).map((document, index) => [index, {
    name: document.name,
    imageUri: document.image,
    jsonUri: new URL(`${String(index + 1).padStart(4, '0')}.json`, base).href,
    loaded: false,
  }]));
  const items = Object.values(legacyAssetItems);
  const nameLength = Math.max(...items.map(item => Buffer.byteLength(item.name, 'utf8')));
  const uriLength = Math.max(...items.map(item => Buffer.byteLength(item.jsonUri, 'utf8')));
  assert.ok(uriLength <= 200, 'Metadata URI exceeds the Core limit');
  const cmConfig = {
    name: policy.collectionName,
    config: {
      collection,
      itemsAvailable: items.length,
      isMutable: true,
      isSequential: hidden,
      configLineSettings: hidden ? null : { prefixName: '', nameLength, prefixUri: '', uriLength, isSequential: false },
      // The CLI JSON reader passes this value directly into the SDK. A hex
      // string or JSON-stringified Uint8Array would encode the wrong digest.
      ...(hidden ? { hiddenSettings: { ...profile.hiddenSettings,
        hash: Array.from(hiddenSettingsForSdk(profile.hiddenSettings).hash) } } : {}),
      guardConfig: {
        addressGate: { address: policy.owner },
        solPayment: { lamports: String(policy.priceSol * 1e9), destination: policy.owner },
      },
      groups: [],
    },
  };
  const plugins = { royalties: {
    type: 'Royalties', basisPoints: policy.royaltyPercent * 100,
    creators: [{ address: policy.owner, percentage: 100 }],
    ruleSet: { type: 'None' },
  } };
  // This is an explicit operator contract, not an on-chain authority assignment.
  // CLI defaults must be checked against it before any future signature.
  const releasePlan = {
    version: 1, stage: 'prepared-offline', networkSelected: false,
    collection, supply: policy.supply,
    publicItems: { count: items.length, firstIndex: 1, lastIndex: policy.supply - 1 },
    reservedAsset: {
      index: 0, name: documents[0].name, owner: policy.owner, collection,
      uri: new URL('0000.json', base).href, created: false,
    },
    requiredAuthorities: {
      collectionUpdateAuthority: policy.owner,
      candyMachineAuthority: policy.owner,
      candyGuardAuthority: policy.owner,
    },
    authoritiesVerifiedOnChain: false,
    payment: { lamports: cmConfig.config.guardConfig.solPayment.lamports, destination: policy.owner },
    royalties: { basisPoints: policy.royaltyPercent * 100, recipient: policy.owner },
    maxPerOrder: policy.maxPerOrder,
    earliestRevealDate: policy.earliestRevealDate, privateRevealMappingVerified: false,
    salesOpen: false, transactionsSent: 0,
    ...(hidden ? { storageMode: profile.storageMode,
      hiddenCommitmentSha256: profile.hiddenSettings.hash,
      commitmentStatus: 'declared-unverified-private-mapping',
      indexedIdentity: 'plain-decimal-1-through-9999', configLineInsertions: 0 } : {}),
  };
  return { cmConfig, assetCache: { assetItems: hidden ? {} : legacyAssetItems }, plugins, documents, releasePlan };
}

export async function prepare(output, options) {
  const result = makePreparation(options);
  const destination = path.resolve(output);
  // A preparation never overwrites a deployment, its cache or transaction record.
  await mkdir(destination, { recursive: false });
  await mkdir(path.join(destination, 'hidden'));
  if (result.releasePlan.storageMode === HIDDEN_SETTINGS) await mkdir(path.join(destination, 'hidden-indexed'));
  const save = (file, data) => writeFile(path.join(destination, file), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await save('cm-config.json', result.cmConfig);
  await save('asset-cache.json', result.assetCache);
  await save('collection-plugins.json', result.plugins);
  await save('release-plan.json', result.releasePlan);
  await save('collection.json', JSON.parse(await readFile(path.join(root, 'metadata/collection.json'), 'utf8')));
  for (let i = 0; i < result.documents.length; i++) {
    await save(`hidden/${String(i).padStart(4, '0')}.json`, result.documents[i]);
    if (i > 0 && result.releasePlan.storageMode === HIDDEN_SETTINGS) {
      await save(`hidden-indexed/${i}.json`, result.documents[i]);
    }
  }
  await save('preparation.json', {
    stage: 'prepared-offline', cliVersion: '0.4.3', cluster: 'devnet',
    supply: policy.supply, machineItems: result.cmConfig.config.itemsAvailable,
    metadataPublished: false, collectionCreated: false, machineCreated: false,
    salesOpen: false, earliestRevealDate: policy.earliestRevealDate,
    ...(result.releasePlan.storageMode === HIDDEN_SETTINGS ? {
      storageMode: HIDDEN_SETTINGS, hiddenCommitmentSha256: result.releasePlan.hiddenCommitmentSha256,
      privateRevealMappingVerified: false, configLineInsertions: 0,
    } : {}),
  });
  return { destination, documents: result.documents.length, machineItems: result.cmConfig.config.itemsAvailable };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw Error('Specify a NEW output directory; no files will be overwritten.');
  console.log(JSON.stringify(await prepare(destination, {
    collection: process.env.COOLBEARS_COLLECTION || '',
    storageMode: process.env.COOLBEARS_STORAGE_MODE,
    hiddenCommitmentSha256: process.env.COOLBEARS_HIDDEN_COMMITMENT_SHA256,
  })));
}
