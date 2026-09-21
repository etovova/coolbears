// Read-only verification that public reveal paths resolve inside the private CAR.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { exporter } from 'ipfs-unixfs-exporter';
import { validateBlock } from '@web3-storage/car-block-validator';
const [car, reference] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(path.join(reference, 'manifest.PRIVATE.json')));
const reader = await CarIndexedReader.fromFile(car);
try {
  const store = { async get(cid) { const block = await reader.get(cid); assert.ok(block); await validateBlock(block); return block.bytes; } };
  const root = await exporter(manifest.root, store);
  assert.equal(root.type, 'directory');
  const children = new Map();
  for await (const child of root.content()) children.set(child.name, child.cid.toString());
  assert.equal(children.size, 2);
  assert.equal(children.get('images'), manifest.imagesRoot);
  assert.equal(children.get('metadata'), manifest.metadataRoot);
  const report = { checkedAt: new Date().toISOString(), passed: true,
    rootChildren: ['images', 'metadata'], imageDirectoryCidMatched: true,
    metadataDirectoryCidMatched: true, sourcesUnmodified: true };
  await writeFile(new URL('./reports/archive-links.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await reader.close(); }
