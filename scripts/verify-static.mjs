import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// The build step creates these browser bundles immediately before staging.
// Check that every generated asset is present and non-empty; comparing a
// multi-megabyte bundle through git diff can overflow Node's default buffer.
const generated=[
  'wallet-standard.js',
  'wallet-standard.js.LEGAL.txt',
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

console.log('Static website bundles match the staged site.');
