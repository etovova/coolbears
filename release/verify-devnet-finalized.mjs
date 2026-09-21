// Read-only evidence for the real Devnet lab. Never signs or sends a transaction.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEVNET_GENESIS } from './settings.mjs';

const run = promisify(execFile);
const endpoint = process.env.COOLBEARS_DEVNET_RPC || 'https://api.devnet.solana.com';
assert.equal(new URL(endpoint).protocol, 'https:');
async function rpc(method, params = []) {
  const { stdout } = await run('curl', ['--silent', '--show-error', '--max-time', '25',
    '--header', 'Content-Type: application/json', '--data-binary',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), endpoint],
  { timeout: 27000, maxBuffer: 1000000 });
  const response = JSON.parse(stdout);
  assert.ok(!response.error, `${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}
const result = { checkedAt: new Date().toISOString(), scope: 'read-only finalized Devnet signatures',
  passed: false, transactions: [] };
try {
  const source = JSON.parse(await readFile(new URL('./reports/devnet.json', import.meta.url), 'utf8'));
  assert.equal(source.status, 'passed', 'Complete the Devnet scenario first');
  const steps = ['collection', 'standalone-item', 'closed-machine', 'open-lab-only',
    'paid-mint', 'close-lab', 'transfer', 'lab-metadata-update'];
  assert.deepEqual(source.transactions.map(t => t.step), steps);
  const signatures = source.transactions.map(t => t.signature);
  assert.equal(new Set(signatures).size, steps.length);
  assert.equal(await rpc('getGenesisHash'), DEVNET_GENESIS);
  const [statuses, balance] = await Promise.all([
    rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]),
    rpc('getBalance', [source.testPayer, { commitment: 'finalized' }]),
  ]);
  assert.equal(statuses.value.length, steps.length);
  for (const [i, status] of statuses.value.entries()) {
    assert.ok(status, `${steps[i]} signature not found`);
    assert.equal(status.err, null, `${steps[i]} failed`);
    assert.equal(status.confirmationStatus, 'finalized', `${steps[i]} not finalized`);
    result.transactions.push({ step: steps[i], signature: signatures[i], slot: status.slot,
      confirmationStatus: status.confirmationStatus, error: status.err });
  }
  result.testPayer = source.testPayer;
  result.balanceSlot = balance.context.slot;
  result.finalizedBalanceLamports = String(balance.value);
  result.limitations = ['Physical Phantom signing and marketplace indexing are not tested here.'];
  result.passed = true;
} catch (error) {
  result.error = String(error.message).replace(/https?:\/\/\S+/g, '[RPC]').slice(0, 350);
  process.exitCode = 1;
}
await writeFile(new URL('./reports/devnet-finalized.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
