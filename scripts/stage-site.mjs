import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

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
const config = await readFile('config.js', 'utf8');
if (!config.includes('demoMode: true') || !config.includes("candyMachineAddress: ''")) throw Error('Sales must remain closed during fresh build');
await rm('public-site', { recursive: true, force: true });
for (const file of files) {
  if (file.startsWith('/') || file.split('/').includes('..')) throw Error('Invalid public path');
  const target = path.join('public-site', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(file, target);
}
await mkdir('public-site/metadata/hidden', { recursive: true });
for (let i = 0; i < policy.supply; i++) {
  const id = String(i).padStart(4, '0');
  await writeFile(`public-site/metadata/hidden/${id}.json`, JSON.stringify({ ...item, name: `CoolBears #${id} — Hidden Bear` }) + '\n');
}
console.log(JSON.stringify({ version: policy.version, staticFiles: files.length, hiddenItems: policy.supply, originalsVerified: true, salesOpen: false }));
