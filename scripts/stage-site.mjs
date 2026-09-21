import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { PublicKey } from '@solana/web3.js';

const files = JSON.parse(await readFile('scripts/public-files.json', 'utf8'));
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
await mkdir('public-site/metadata/hidden', { recursive: true });
await mkdir('public-site/metadata/mint', { recursive: true });
await mkdir('metadata/mint', { recursive: true });
for (let i = 0; i < policy.supply; i++) {
  const id = String(i).padStart(4, '0');
  const json = JSON.stringify({ ...item, name: `CoolBears #${id} — Hidden Bear` }) + '\n';
  await writeFile(`public-site/metadata/hidden/${id}.json`, json);
  if (i > 0) {
    await writeFile(`public-site/metadata/mint/${i}.json`, json);
    await writeFile(`metadata/mint/${i}.json`, json);
  }
}
console.log(JSON.stringify({ version: policy.version, staticFiles: files.length, hiddenItems: policy.supply, originalsVerified: true, salesOpen: false }));
