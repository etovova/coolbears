import './cli-transport.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { confirmSignature } from './confirm.mjs';

const { TransactionCommand } = await import('./node_modules/@metaplex-foundation/cli/dist/TransactionCommand.js');
const initialize = TransactionCommand.prototype.init;
TransactionCommand.prototype.init = async function () {
  await initialize.call(this);
  assert.equal(new URL(this.context.umi.rpc.getEndpoint()).href, new URL(process.env.COOLBEARS_RPC_URL).href, 'CLI RPC must match the explicit transport endpoint');
  this.context.umi.rpc.confirmTransaction = (signature, options) => confirmSignature(process.env.COOLBEARS_RPC_URL, signature, { commitment: options?.commitment === 'confirmed' ? 'confirmed' : 'finalized' });
};

await import('./node_modules/@metaplex-foundation/cli/bin/run.js');
if (process.env.COOLBEARS_LAB_OPERATION) {
  const directory = process.env.COOLBEARS_LAB_OPERATION;
  const record = JSON.parse(await readFile(path.join(directory, 'signed-transaction.json'), 'utf8'));
  const confirmation = await confirmSignature(process.env.COOLBEARS_RPC_URL, record.signature);
  await writeFile(path.join(directory, 'finalized.json'), JSON.stringify(confirmation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.error(`Independently verified finalized: ${record.signature}`);
}
