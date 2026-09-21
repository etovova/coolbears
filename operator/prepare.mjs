import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKey } from '@metaplex-foundation/umi';

const root = fileURLToPath(new URL('../', import.meta.url));
export const policy = JSON.parse(await readFile(path.join(root, 'metadata/policy.json'), 'utf8'));
const hidden = JSON.parse(await readFile(path.join(root, 'metadata/0000.json'), 'utf8'));

export function makePreparation({ collection = '', metadataBase } = {}) {
  assert.equal(policy.supply, 10000);
  assert.equal(policy.priceSol, 0.5);
  assert.equal(policy.royaltyPercent, 7);
  assert.equal(hidden.description, policy.hiddenDescription);
  publicKey(policy.owner);
  if (collection) publicKey(collection);
  const base = new URL(metadataBase ?? `${policy.website}/metadata/hidden/`);
  assert.equal(base.protocol, 'https:', 'Metadata must use HTTPS');
  assert.ok(base.pathname.endsWith('/') && !base.search && !base.hash && !base.username && !base.password, 'Use a directory URL without credentials, query or fragment');
  const documents = Array.from({ length: policy.supply }, (_, index) => {
    const document = structuredClone(hidden);
    document.name = policy.hiddenName.replace('{index:04d}', String(index).padStart(4, '0'));
    assert.equal(Buffer.byteLength(document.name, 'utf8') <= 32, true);
    for (const field of ['attributes', 'rank', 'rarity', 'rarity_score']) assert.ok(!(field in document));
    return document;
  });
  const assetItems = Object.fromEntries(documents.slice(1).map((document, index) => [index, {
    name: document.name,
    imageUri: document.image,
    jsonUri: new URL(`${String(index + 1).padStart(4, '0')}.json`, base).href,
    loaded: false,
  }]));
  const items = Object.values(assetItems);
  const nameLength = Math.max(...items.map(item => Buffer.byteLength(item.name, 'utf8')));
  const uriLength = Math.max(...items.map(item => Buffer.byteLength(item.jsonUri, 'utf8')));
  assert.ok(uriLength <= 200, 'Metadata URI exceeds the Core limit');
  const cmConfig = {
    name: policy.collectionName,
    config: {
      collection,
      itemsAvailable: items.length,
      isMutable: true,
      isSequential: false,
      configLineSettings: { prefixName: '', nameLength, prefixUri: '', uriLength, isSequential: false },
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
  return { cmConfig, assetCache: { assetItems }, plugins, documents };
}

export async function prepare(output, options) {
  const result = makePreparation(options);
  const destination = path.resolve(output);
  // A preparation never overwrites a deployment, its cache or transaction record.
  await mkdir(destination, { recursive: false });
  await mkdir(path.join(destination, 'hidden'));
  const save = (file, data) => writeFile(path.join(destination, file), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await save('cm-config.json', result.cmConfig);
  await save('asset-cache.json', result.assetCache);
  await save('collection-plugins.json', result.plugins);
  await save('collection.json', JSON.parse(await readFile(path.join(root, 'metadata/collection.json'), 'utf8')));
  for (let i = 0; i < result.documents.length; i++) {
    await save(`hidden/${String(i).padStart(4, '0')}.json`, result.documents[i]);
  }
  await save('preparation.json', {
    stage: 'prepared-offline', cliVersion: '0.4.3', cluster: 'devnet',
    supply: policy.supply, machineItems: result.cmConfig.config.itemsAvailable,
    metadataPublished: false, collectionCreated: false, machineCreated: false,
    salesOpen: false, earliestRevealDate: policy.earliestRevealDate,
  });
  return { destination, documents: result.documents.length, machineItems: result.cmConfig.config.itemsAvailable };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw Error('Specify a NEW output directory; no files will be overwritten.');
  console.log(JSON.stringify(await prepare(destination, { collection: process.env.COOLBEARS_COLLECTION || '' })));
}
