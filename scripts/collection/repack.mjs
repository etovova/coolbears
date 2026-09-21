// Build a fresh, deterministic release using only the 10000 approved PNGs.
// No old temporary directory entries are reachable from the new root.
import { readFile, writeFile, mkdir, open, copyFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { CarWriter } from '@ipld/car/writer';
import { exporter } from 'ipfs-unixfs-exporter';
import { importer } from 'ipfs-unixfs-importer';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as pb from '@ipld/dag-pb';
import { commitmentFor } from '../../chain/spec.mjs';

const [source, checkpoint, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(`${checkpoint}/manifest.PRIVATE.json`, 'utf8'));
const checksums = JSON.parse(await readFile(`${checkpoint}/image-checksums.PRIVATE.json`, 'utf8'));
const car = await CarIndexedReader.fromFile(source);
const sourceStore = { async *get(cid) { const b = await car.get(cid); assert(b); yield b.bytes; } };
const placeholder = CID.createV1(pb.code, await sha256.digest(new Uint8Array()));
const { writer, out } = CarWriter.create([placeholder]);
const target = `${output}/collection.car`;
const writing = pipeline(out, createWriteStream(target));
const seen = new Set();
const blockstore = { async put(cid, bytes) {
  const key = cid.toString(); if (!seen.has(key)) { await writer.put({ cid, bytes }); seen.add(key); }
  return cid;
} };
const options = { cidVersion: 1, rawLeaves: true, wrapWithDirectory: false,
  shardSplitThresholdBytes: 262144, shardSplitStrategy: 'block-bytes', fileImportConcurrency: 1, blockWriteConcurrency: 1 };
async function collect(path) {
  const f = await exporter(path, sourceStore), chunks = [];
  for await (const b of f.content()) chunks.push(b);
  return Buffer.concat(chunks);
}
async function *images() {
  for (let i = 0; i < 10000; i++) {
    const id = String(i).padStart(4, '0'), bytes = await collect(`${manifest.imagesRoot}/${id}.png`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), checksums[i].sha256);
    yield { path: `images/${id}.png`, content: bytes };
    if ((i + 1) % 1000 === 0) console.log(`Packaged original PNG ${i + 1}/10000`);
  }
}
let imagesDir;
for await (const entry of importer(images(), blockstore, options)) if (entry.path === 'images') imagesDir = entry;
assert(imagesDir);
async function *metadata() {
  for (let i = 0; i < 10000; i++) {
    const id = String(i).padStart(4, '0'), item = JSON.parse(await collect(`${manifest.metadataRoot}/${id}.json`));
    item.image = `ipfs://${imagesDir.cid}/${id}.png`;
    item.properties.files = [{ uri: item.image, type: 'image/png' }];
    yield { path: `metadata/${id}.json`, content: Buffer.from(JSON.stringify(item) + '\n') };
  }
}
let metadataDir;
for await (const entry of importer(metadata(), blockstore, options)) if (entry.path === 'metadata') metadataDir = entry;
assert(metadataDir);
const rootBytes = pb.encode(pb.prepare({ Data: Uint8Array.of(8, 1), Links: [
  { Name: 'images', Hash: imagesDir.cid, Tsize: Number(imagesDir.size) },
  { Name: 'metadata', Hash: metadataDir.cid, Tsize: Number(metadataDir.size) },
] }));
const root = CID.createV1(pb.code, await sha256.digest(rootBytes));
await blockstore.put(root, rootBytes); await writer.close(); await writing; await car.close();
const file = await open(target, 'r+'); await CarWriter.updateRootsInFile(file, [root]); await file.sync(); await file.close();
const hash = createHash('sha256'); let size = 0;
for await (const bytes of createReadStream(target)) { hash.update(bytes); size += bytes.length; }
const map = Array.from({ length: 10000 }, (_, index) => ({ index,
  name: `CoolBears #${String(index).padStart(4, '0')}`, uri: `ipfs://${root}/metadata/${String(index).padStart(4, '0')}.json` }));
const next = { version: 'core-v2-20260921', root: root.toString(), imagesRoot: imagesDir.cid.toString(),
  metadataRoot: metadataDir.cid.toString(), finalPrefix: `ipfs://${root}/metadata/`, bytes: size, sha256: hash.digest('hex') };
await writeFile(`${output}/manifest.PRIVATE.json`, JSON.stringify(next, null, 2) + '\n');
await writeFile(`${output}/reveal-map.PRIVATE.json`, JSON.stringify(map) + '\n');
await writeFile(`${output}/commitment.json`, JSON.stringify({ commitment: await commitmentFor(map) }, null, 2) + '\n');
for (const name of ['plan.PRIVATE.json', 'image-checksums.PRIVATE.json']) await copyFile(`${checkpoint}/${name}`, `${output}/${name}`);
console.log(JSON.stringify({ images: 10000, metadata: 10000, bytes: size, uniqueBlocks: seen.size, originalsUnchanged: true, temporaryFilesExcluded: true }));
