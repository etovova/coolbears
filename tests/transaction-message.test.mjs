import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
test('Mobile blockhash errors give recovery steps without clearing a pending operation', async () => {
  const source = await readFile('solana-test/controller.mjs', 'utf8');
  const code = source.slice(source.indexOf('function transactionMessage('), source.indexOf('async function run('));
  const message = runInNewContext(`${code}\ntransactionMessage`);
  const error = new Error('Simulation failed. Transaction simulation failed: Blockhash not found.');
  assert.match(message(error, { signature: 'pending' }), /Проверить состояние/);
  assert.match(message(error, undefined), /Solana Devnet/);
  assert.match(message({ code: 4001 }, undefined), /отменено/);
  assert.equal(message(new Error('Other failure')), 'Other failure');
});
