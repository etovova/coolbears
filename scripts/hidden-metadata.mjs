import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const policy = JSON.parse(await readFile(path.join(root, 'metadata/policy.json'), 'utf8'));
const template = JSON.parse(await readFile(path.join(root, 'metadata/0000.json'), 'utf8'));

export function hiddenDocuments() {
  assert.equal(policy.supply, 10000);
  assert.equal(template.description, policy.hiddenDescription);
  assert.equal(template.image, `${policy.website}/assets/collection/gif.gif`);
  for (const field of ['attributes', 'rank', 'rarity', 'rarity_score']) assert.ok(!(field in template));
  return Array.from({ length: policy.supply }, (_, index) => ({
    ...structuredClone(template),
    name: policy.hiddenName.replace('{index:04d}', String(index).padStart(4, '0')),
  }));
}

export function hiddenFiles() {
  return hiddenDocuments().map((document, index) => {
    const body = JSON.stringify(document) + '\n';
    return {
      path: `metadata/hidden/${String(index).padStart(4, '0')}.json`, body,
      sha256: createHash('sha256').update(body).digest('hex'),
      gitBlob: createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex'),
    };
  });
}

export async function verifyHiddenFiles(directory = root) {
  const files = hiddenFiles();
  const actual = await readdir(path.join(directory, 'metadata/hidden'));
  assert.equal(actual.length, files.length, 'Unexpected or missing hidden metadata files');
  for (const file of files) {
    assert.equal(await readFile(path.join(directory, file.path), 'utf8'), file.body, `Unapproved metadata: ${file.path}`);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--write') throw Error('Use --write to generate the approved public hidden metadata');
  await mkdir(path.join(root, 'metadata/hidden'), { recursive: true });
  for (const file of hiddenFiles()) {
    try { await writeFile(path.join(root, file.path), file.body, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const files = await verifyHiddenFiles();
  console.log(JSON.stringify({ hiddenMetadata: files.length, imagesChanged: false, traitsPublished: false }));
}
