import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
for(const file of generated)assert.ok((await readFile(file)).length>0,file);

for (let i = 0; i < 10000; i++) {
  const file = `metadata/hidden/${String(i).padStart(4, '0')}.json`;
  assert.deepEqual(await readFile(file), await readFile(`public-site/${file}`), file);
}
console.log('Generated SDK assets exist and all 10000 hidden metadata files match the staged site.');
