import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// The build step creates these browser bundles immediately before staging.
// Check that every generated asset is present and non-empty; comparing a
// multi-megabyte bundle through git diff can overflow Node's default buffer.
const generated=[
  'solana-test/sdk.js',
  'solana-test/sdk.js.LEGAL.txt',
  'wallet-standard.js',
  'wallet-standard.js.LEGAL.txt',
  'solana-upload/sdk.js',
  'solana-upload/sdk.js.LEGAL.txt'
];
for(const file of generated){
  const built=await readFile(file);
  assert.ok(built.length>0,file);
  assert.ok(built.equals(await readFile(`public-site/${file}`)),`Staged bundle differs: ${file}`);
  // The built-in Pages publisher serves HEAD directly. A fresh Actions build
  // must not hide stale committed bundles that this second publisher can serve.
  if(process.env.CI==='true'||process.argv.includes('--check-committed')){
    const committed=execFileSync('git',['show',`HEAD:${file}`],{maxBuffer:10*1024*1024});
    assert.ok(built.equals(committed),`Run build:solana and commit generated asset: ${file}`);
  }
}

for (let i = 0; i < 10000; i++) {
  const file = `metadata/hidden/${String(i).padStart(4, '0')}.json`;
  assert.deepEqual(await readFile(file), await readFile(`public-site/${file}`), file);
}
console.log('All generated bundles and 10000 hidden metadata files match the staged site.');
