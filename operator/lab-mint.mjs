// One isolated Devnet acceptance mint. Not the production issuer or wallet UI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, createSignerFromKeypair, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { fetchAsset, fetchCollection, mplCore } from '@metaplex-foundation/mpl-core';
import { fetchCandyMachine, fetchCandyGuard, mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { confirmSignature } from './confirm.mjs';
import { DEVNET } from './preflight.mjs';
import { makePreparation, policy } from './prepare.mjs';

const directory = path.resolve(process.argv[2] || 'private/cli-devnet-20260921');
const load = async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
const umi = createUmi(process.env.COOLBEARS_RPC_URL, { commitment: 'finalized', disableRetryOnRateLimit: true }).use(mplCore()).use(mplCandyMachine());
const signer = async file => createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(await load(file))));
umi.use(signerIdentity(await signer('payer.json')));
assert.equal(umi.identity.publicKey, 'BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF', 'Lab payer required');
assert.equal(await umi.rpc.getGenesisHash(), DEVNET);
const config = await load('cm-config.json');
const asset = await signer('mint.json');
assert.equal((await umi.rpc.getAccount(asset.publicKey)).exists, false, 'The saved asset already exists; do not mint again');
const machine = await fetchCandyMachine(umi, publicKey(config.candyMachineId));
const guard = await fetchCandyGuard(umi, machine.mintAuthority);
const collection = await fetchCollection(umi, machine.collection);
assert.equal(machine.data.itemsAvailable, 2n);
assert.equal(machine.itemsLoaded, 2);
assert.equal(machine.itemsRedeemed, 0n);
assert.equal(machine.collection, config.config.collection);
assert.equal(guard.guards.addressGate.value.address, umi.identity.publicKey);
assert.equal(guard.guards.solPayment.value.lamports.basisPoints, 500000000n);
assert.equal(guard.guards.solPayment.value.destination, policy.owner);
assert.equal(collection.royalties.basisPoints, 700);
assert.equal(collection.royalties.creators[0].address, policy.owner);

const input = {
  candyMachine: machine.publicKey, candyGuard: machine.mintAuthority,
  collection: machine.collection, asset, owner: publicKey(policy.owner),
  mintArgs: { solPayment: { destination: publicKey(policy.owner) } },
};
const closedTx = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
  ...input, payer: umi.identity, minter: createNoopSigner(publicKey(policy.owner)),
})).setBlockhash(await umi.rpc.getLatestBlockhash()).buildAndSign(umi);
const closedSimulation = await umi.rpc.simulateTransaction(closedTx, { verifySignatures: false });
assert.ok(closedSimulation.err, 'Non-allowlisted minter must be rejected');
assert.ok(closedSimulation.logs.some(line => /AddressNotAuthorized|AddressGate|address gate/i.test(line)), 'The negative simulation must fail specifically at addressGate');

const builder = setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, input));
assert.ok(builder.fitsInOneTransaction(umi));
const transaction = await builder.setBlockhash(await umi.rpc.getLatestBlockhash()).buildAndSign(umi);
const signature = await umi.rpc.sendTransaction(transaction, { skipPreflight: false, maxRetries: 0 });
const finalized = await confirmSignature(process.env.COOLBEARS_RPC_URL, signature);
await writeFile(path.join(process.env.COOLBEARS_LAB_OPERATION, 'finalized.json'), JSON.stringify(finalized, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const minted = await fetchAsset(umi, asset.publicKey);
const updatedMachine = await fetchCandyMachine(umi, machine.publicKey);
assert.equal(minted.owner, policy.owner);
assert.equal(minted.updateAuthority.type, 'Collection');
assert.equal(minted.updateAuthority.address, collection.publicKey);
const expected = Object.values(makePreparation().assetCache.assetItems).slice(0, 2).find(item => item.jsonUri === minted.uri);
assert.ok(expected, 'Minted URI must be one of the two loaded hidden entries');
assert.equal(minted.name, expected.name);
assert.equal(updatedMachine.itemsRedeemed, 1n);

const response = await fetch(process.env.COOLBEARS_RPC_URL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [finalized.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }] }),
});
const body = await response.json();
assert.ok(response.ok && body.result && !body.error, 'Finalized transaction details required');
assert.equal(body.result.meta.err, null);
const ownerIndex = body.result.transaction.message.accountKeys.indexOf(policy.owner);
assert.ok(ownerIndex >= 0);
const payment = body.result.meta.postBalances[ownerIndex] - body.result.meta.preBalances[ownerIndex];
assert.equal(payment, 500000000);
const report = {
  checkedAt: new Date().toISOString(), cluster: 'devnet', production: false,
  collection: collection.publicKey, candyMachine: machine.publicKey, candyGuard: machine.mintAuthority,
  asset: asset.publicKey, owner: minted.owner, name: minted.name, uri: minted.uri,
  signature: finalized.signature, confirmation: finalized.confirmationStatus,
  paymentToOwnerLamports: payment, royaltyBasisPoints: collection.royalties.basisPoints,
  machineItems: 2, loadedItems: updatedMachine.itemsLoaded, redeemedItems: Number(updatedMachine.itemsRedeemed),
  addressGateStillClosed: true, unauthorizedMintSimulation: { err: closedSimulation.err, logs: closedSimulation.logs },
  physicalWalletVerified: false, magicEdenIndexed: false,
};
await writeFile('operator/reports/cli-devnet-mint.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
