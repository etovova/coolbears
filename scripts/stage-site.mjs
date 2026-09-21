import { readFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { PublicKey } from '@solana/web3.js';
import { verifyHiddenFiles } from './hidden-metadata.mjs';

const files = JSON.parse(await readFile('scripts/public-files.json', 'utf8'));
const hidden = await verifyHiddenFiles();
files.push(...hidden.map(file => file.path));
const policy = JSON.parse(await readFile('metadata/policy.json', 'utf8'));
const collection = JSON.parse(await readFile('metadata/collection.json', 'utf8'));
const item = JSON.parse(await readFile('metadata/0000.json', 'utf8'));
if (collection.description !== policy.collectionDescription || item.description !== policy.hiddenDescription) throw Error('Unapproved description');
if (item.attributes || item.rank || item.rarity) throw Error('Private traits in hidden metadata');
for (const kind of ['logo', 'banner', 'gif']) {
  const file = `assets/collection/${kind}.${kind === 'gif' ? 'gif' : 'png'}`;
  const data = await readFile(file);
  if (createHash('sha256').update(data).digest('hex') !== policy.publicAssets[kind].sha256) throw Error(`Changed original ${kind}`);
}
const scope = { window: {}, document: { addEventListener() {} } };
runInNewContext(await readFile('config.js', 'utf8'), scope);
const config = scope.window.COOLBEARS_CONFIG;
if (config.demoMode !== true || config.candyMachineAddress !== '' || config.collectionAddress !== '' || config.cluster !== 'devnet') throw Error('Sales must remain closed during fresh build');
if (config.priceSol !== policy.priceSol || config.ownerAddress !== policy.owner || config.supply !== policy.supply || config.royaltyPercent !== policy.royaltyPercent || config.maxPerOrder !== policy.maxPerOrder) throw Error('Site settings do not match approved policy');
if (!(config.priceSol > 0) || !Number.isSafeInteger(config.priceSol * 1e9)) throw Error('Invalid price in lamports');
if (new PublicKey(config.ownerAddress).toBase58() !== config.ownerAddress) throw Error('Invalid owner address');
await rm('public-site', { recursive: true, force: true });
for (const file of files) {
  if (file.startsWith('/') || file.split('/').includes('..')) throw Error('Invalid public path');
  const target = path.join('public-site', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(file, target);
}
console.log(JSON.stringify({ version: policy.version, staticFiles: files.length, hiddenMetadata: hidden.length, originalsVerified: true, salesOpen: false }));
