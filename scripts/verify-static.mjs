import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { verifyHiddenFiles } from './hidden-metadata.mjs';

// The build step creates these browser bundles immediately before staging.
// Check that every generated asset is present and non-empty; comparing a
// multi-megabyte bundle through git diff can overflow Node's default buffer.
const generated=[
  'wallet-standard.js',
  'wallet-standard.js.LEGAL.txt',
  'devnet/app.js',
  'devnet/app.js.LEGAL.txt',
];
for(const file of generated){
  const built=await readFile(file);
  assert.ok(built.length>0,file);
  assert.ok(built.equals(await readFile(`public-site/${file}`)),`Staged bundle differs: ${file}`);
  // The built-in Pages publisher serves HEAD directly. A fresh Actions build
  // must not hide stale committed bundles that this second publisher can serve.
  if(process.env.CI==='true'||process.argv.includes('--check-committed')){
    const committed=execFileSync('git',['show',`HEAD:${file}`],{maxBuffer:10*1024*1024});
    assert.ok(built.equals(committed),`Run build:wallet and commit generated asset: ${file}`);
  }
}

const hidden = await verifyHiddenFiles('public-site');
if (process.env.CI === 'true' || process.argv.includes('--check-committed')) {
  const entries = execFileSync('git', ['ls-tree', '-r', 'HEAD', 'metadata/hidden/'], { maxBuffer: 2 * 1024 * 1024 }).toString().trim().split('\n');
  const blobs = new Map(entries.map(line => { const [head, file] = line.split('\t'); return [file, head.split(' ')[2]]; }));
  assert.equal(blobs.size, hidden.length, 'Commit all approved hidden metadata for both Pages publishers');
  for (const file of hidden) assert.equal(blobs.get(file.path), file.gitBlob, `Stale committed metadata: ${file.path}`);
}

console.log(`Static website bundles and ${hidden.length} hidden metadata files match the staged site.`);
