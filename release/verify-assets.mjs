// Uses the same official IPFS CAR reader/exporter as ipfs-car, without writing
// another 13 GB copy of the artwork. No source bytes or metadata are modified.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { recursive as exportUnixFS } from 'ipfs-unixfs-exporter';
import { validateBlock } from '@web3-storage/car-block-validator';

const [carPath, references, metadataDir] = process.argv.slice(2);
if (!carPath || !references || !metadataDir) throw Error('Usage: verify-assets.mjs CAR PRIVATE_REFERENCE_DIR PRIVATE_METADATA_DIR');
const load = async p => JSON.parse(await readFile(p, 'utf8'));
const hashes = await load(path.join(references, 'image-checksums.PRIVATE.json'));
const plan = await load(path.join(references, 'plan.PRIVATE.json'));
const manifest = await load(path.join(references, 'manifest.PRIVATE.json'));
assert.equal(hashes.length, 10000); assert.equal(plan.length, 10000);
const expected = new Map(hashes.map(x => [x.index, x]));
assert.equal(expected.size, 10000);
const imageIds = new Set(), metadataIds = new Set(), pngHashes = new Set(), pixels = new Set();
const started = Date.now();
const png = spawn(process.env.COOLBEARS_PYTHON || 'python3', [fileURLToPath(new URL('./verify-png.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: png.stdout })[Symbol.asyncIterator]();
png.on('error', error => { console.error(error.message); process.exitCode = 1; });
const reader = await CarIndexedReader.fromFile(carPath);
let blocksVerified = 0;
try {
  const roots = await reader.getRoots();
  assert.equal(roots.length, 1);
  assert.ok(roots[0].toString() === manifest.root, 'CAR root does not match saved private manifest');
  const blockstore = { async get(cid) {
    const block = await reader.get(cid);
    assert.ok(block, 'Missing CAR block');
    await validateBlock(block); blocksVerified++;
    return block.bytes;
  } };
  for await (const entry of exportUnixFS(roots[0], blockstore)) {
    if (entry.type === 'directory') continue;
    assert.ok(entry.type === 'file' || entry.type === 'raw', 'Unexpected archive entry');
    const parts = entry.path.split('/');
    const filename = parts.at(-1);
    const chunks = []; let bytes = 0;
    for await (const chunk of (typeof entry.content === 'function' ? entry.content() : entry.content)) {
      bytes += chunk.length; assert.ok(bytes < 20_000_000, 'Unexpected file size'); chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (parts.at(-2) === 'images' && /^\d{4}\.png$/.test(filename)) {
      const id = Number(filename.slice(0, 4)); const ref = expected.get(id);
      assert.ok(ref && !imageIds.has(id), 'Unexpected or duplicated image index');
      const digest = createHash('sha256').update(raw).digest('hex');
      assert.equal(raw.length, ref.bytes, `PNG ${id}: size changed`);
      assert.equal(digest, ref.sha256, `PNG ${id}: bytes changed`);
      assert.ok(!pngHashes.has(digest), `Duplicate image ${id}`); pngHashes.add(digest);
      const header = Buffer.alloc(4); header.writeUInt32BE(raw.length);
      png.stdin.write(header);
      if (!png.stdin.write(raw)) await once(png.stdin, 'drain');
      const next = await lines.next(); assert.ok(!next.done, 'PNG verifier stopped');
      const decoded = JSON.parse(next.value);
      assert.ok(!decoded.error, `PNG ${id}: ${decoded.error}`);
      assert.deepEqual(decoded.size, [2000, 2000], `PNG ${id}: wrong dimensions`);
      assert.equal(decoded.pixel_sha256, ref.pixel_sha256, `PNG ${id}: decoded pixels changed`);
      assert.ok(!pixels.has(decoded.pixel_sha256), `Duplicate rendered pixels ${id}`); pixels.add(decoded.pixel_sha256);
      imageIds.add(id);
      if (imageIds.size % 250 === 0) console.log(`Verified PNG: ${imageIds.size}/10000`);
    } else if (parts.at(-2) === 'metadata' && /^\d{4}\.json$/.test(filename)) {
      const id = Number(filename.slice(0, 4));
      assert.ok(id < 10000 && !metadataIds.has(id), 'Unexpected metadata index');
      assert.ok(raw.equals(await readFile(path.join(metadataDir, filename))), `Metadata ${id}: source mismatch`);
      const json = JSON.parse(raw); const item = plan[id];
      assert.equal(item.index, id); assert.equal(json.name, `CoolBears #${filename.slice(0, 4)}`);
      assert.deepEqual(Object.fromEntries(json.attributes.map(x => [x.trait_type, x.value])), item.traits, `Metadata ${id}: trait mismatch`);
      assert.equal(json.properties.rarity.rank, item.rank);
      assert.ok(json.image.endsWith(`/${filename.slice(0, 4)}.png`), `Metadata ${id}: wrong image`);
      metadataIds.add(id);
    } else {
      throw Error('Unexpected archive file category');
    }
  }
  assert.equal(imageIds.size, 10000); assert.equal(metadataIds.size, 10000);
  const carHash = createHash('sha256');
  for await (const bytes of createReadStream(carPath)) carHash.update(bytes);
  assert.equal(carHash.digest('hex'), manifest.sha256, 'Full CAR checksum differs');
  const report = { checkedAt: new Date().toISOString(), passed: true,
    images: imageIds.size, metadata: metadataIds.size, uniquePngBytes: pngHashes.size,
    uniqueDecodedImages: pixels.size, dimensions: [2000, 2000], blocksVerified,
    fullCarChecksumMatched: true, sourcesUnmodified: true, elapsedSeconds: (Date.now() - started) / 1000 };
  await mkdir(new URL('./reports/', import.meta.url), { recursive: true });
  await writeFile(new URL('./reports/assets.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await reader.close(); png.stdin.end(); png.kill();
}
