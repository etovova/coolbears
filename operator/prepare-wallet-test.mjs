// One guard update on the EXISTING two-item Devnet laboratory.
// Never creates a collection, machine, or NFT. Requires a new durable operation directory.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, signerIdentity, publicKey, some } from '@metaplex-foundation/umi';
import { fetchCandyGuard, mplCandyMachine, updateCandyGuard } from '@metaplex-foundation/mpl-core-candy-machine';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { confirmSignature } from './confirm.mjs';
import { createClient, readState } from '../devnet/core.mjs';
import { settings as S } from '../devnet/settings.mjs';

assert.equal(process.env.COOLBEARS_RPC_URL, S.rpc);
assert.ok(process.env.COOLBEARS_LAB_OPERATION, 'A new private journal is required');
const directory = path.resolve('private/cli-devnet-20260921');
const client = createClient();
const before = await readState(client, S.laboratory);
assert.equal(before.machine.itemsRedeemed, 1n, 'Exactly one test item must remain');
const umi = createUmi(S.rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true }).use(mplCore()).use(mplCandyMachine());
const secret = Uint8Array.from(JSON.parse(await readFile(path.join(directory, 'payer.json'), 'utf8')));
umi.use(signerIdentity(createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(secret))));
assert.equal(umi.identity.publicKey, S.laboratory);
const current = await fetchCandyGuard(umi, publicKey(S.guard));
const guards = { ...current.guards, addressGate: some({ address: publicKey(S.owner) }) };
const transaction = await updateCandyGuard(umi, { candyGuard: publicKey(S.guard), guards, groups: current.groups })
  .setBlockhash(await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' })).buildAndSign(umi);
// The preloaded transport verifies signatures/simulation and durably records bytes before one send.
const signature = await umi.rpc.sendTransaction(transaction, { commitment: 'confirmed', skipPreflight: false, maxRetries: 5 });
const receipt = await confirmSignature(S.rpc, signature);
await writeFile(path.join(process.env.COOLBEARS_LAB_OPERATION, 'finalized.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const after = await readState(client);
assert.equal(after.machine.itemsRedeemed, 1n);
const report = {
  checkedAt: new Date().toISOString(), cluster: 'devnet', production: false,
  action: 'existing-laboratory-address-gate-to-owner', signature: receipt.signature,
  confirmation: receipt.confirmationStatus, slot: receipt.context.slot,
  machine: S.machine, collection: S.collection, guard: S.guard,
  beforeAllowed: S.laboratory, nowAllowed: S.owner, priceLamports: String(S.price),
  loaded: 2, redeemed: 1, nftsCreatedByThisOperation: 0, salesOpen: false,
};
await writeFile('operator/reports/wallet-test-guard.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
