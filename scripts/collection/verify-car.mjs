import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { exporter } from 'ipfs-unixfs-exporter';

const [carPath, checkpoint] = process.argv.slice(2);
const load = async name => JSON.parse(await readFile(`${checkpoint}/${name}`, 'utf8'));
const manifest = await load('manifest.PRIVATE.json'), plan = await load('plan.PRIVATE.json'), checksums = await load('image-checksums.PRIVATE.json');
const map = await load('reveal-map.PRIVATE.json');
const car = await CarIndexedReader.fromFile(carPath);
const store = { async *get(cid) {
  const block = await car.get(cid); assert(block, 'Missing CAR block');
  assert.equal(cid.multihash.code, 0x12);
  assert.deepEqual(new Uint8Array(createHash('sha256').update(block.bytes).digest()), cid.multihash.digest);
  yield block.bytes;
} };
async function bytes(path) {
  const file = await exporter(path, store); const chunks = [];
  for await (const chunk of file.content()) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const worker = spawn('python3', ['scripts/collection/check-pixels.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
let pixelReport = ''; worker.stdout.on('data', b => { pixelReport += b; });
const completed = once(worker, 'exit');
let workerError; worker.stdin.on('error', e => { workerError = e; });
async function feed(data) { if (workerError) throw workerError; if (!worker.stdin.write(data)) await once(worker.stdin, 'drain'); }
const unique = new Set(), categories = ['Background', 'Body', 'Clothes', 'Mouth', 'Eyes', 'Head', 'Ears'];
const frequencies = Object.fromEntries(categories.map(c => [c, plan.reduce((m,p) => (m[p.traits[c]]=(m[p.traits[c]]||0)+1,m), {})]));
for (let i = 0; i < 10000; i++) {
  const id = String(i).padStart(4, '0'), png = await bytes(`${manifest.imagesRoot}/${id}.png`);
  const hash = createHash('sha256').update(png).digest('hex');
  assert.equal(hash, checksums[i].sha256); assert.equal(png.length, checksums[i].bytes);
  assert(!unique.has(hash)); unique.add(hash);
  const metadata = JSON.parse(await bytes(`${manifest.metadataRoot}/${id}.json`));
  assert.equal(metadata.name, map[i].name);
  assert.equal(map[i].uri, `ipfs://${manifest.root}/metadata/${id}.json`);
  assert(metadata.image === `ipfs://${manifest.imagesRoot}/${id}.png` || metadata.image === `ipfs://${manifest.root}/images/${id}.png`);
  assert.deepEqual(metadata.attributes, categories.map(c => ({ trait_type: c, value: plan[i].traits[c] })));
  assert.equal(metadata.properties.rarity.rank, plan[i].rank);
  assert.equal(metadata.properties.rarity.score, plan[i].score);
  assert.deepEqual(metadata.properties.rarity.trait_frequencies, Object.fromEntries(categories.map(c => [c, { count: frequencies[c][plan[i].traits[c]], percentage: frequencies[c][plan[i].traits[c]] / 100 }])));
  const meta = Buffer.from(JSON.stringify(checksums[i])); const length = Buffer.alloc(4); length.writeUInt32BE(meta.length);
  await feed(length); await feed(meta); await feed(png);
  if ((i + 1) % 1000 === 0) console.log(`Verified original PNG/JSON ${i + 1}/10000`);
}
worker.stdin.end(); const [code] = await completed; assert.equal(code, 0);
await car.close();
const report = { pngFiles: 10000, jsonFiles: 10000, originalByteHashes: 10000, uniquePngHashes: unique.size,
  traitsRanksFrequenciesVerified: true, referencedBlockHashesVerified: true, ...JSON.parse(pixelReport) };
await writeFile('private/car-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
