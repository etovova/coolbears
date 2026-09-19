import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// Both Pages publishers must serve exactly the same generated public assets.
execFileSync('git', ['diff', '--exit-code', '--', 'solana-test/sdk.js', 'solana-test/sdk.js.LEGAL.txt', 'wallet-standard.js', 'wallet-standard.js.LEGAL.txt'], { stdio: 'pipe' });
for (let i = 0; i < 10000; i++) {
  const file = `metadata/hidden/${String(i).padStart(4, '0')}.json`;
  assert.deepEqual(await readFile(file), await readFile(`public-site/${file}`), file);
}
console.log('Both Pages publishing methods have matching SDK and 10000 hidden metadata files.');
