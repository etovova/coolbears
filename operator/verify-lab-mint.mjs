// Recover an interrupted confirmation using reads only. Never builds or sends a mint.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey } from '@metaplex-foundation/umi';
import { deserializeAssetV1, deserializeCollectionV1, mplCore } from '@metaplex-foundation/mpl-core';
import { deserializeCandyMachine, fetchCandyGuard, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { DEVNET } from './preflight.mjs';
import { policy, makePreparation } from './prepare.mjs';

assert.ok(!process.env.COOLBEARS_LAB_OPERATION, 'Read-only recovery must not enable sending');
const directory = path.resolve(process.argv[2]);
const operation = path.resolve(process.argv[3]);
const config = JSON.parse(await readFile(path.join(directory, 'cm-config.json'), 'utf8'));
const identities = JSON.parse(await readFile(path.join(directory, 'identities.json'), 'utf8'));
const record = JSON.parse(await readFile(path.join(operation, 'signed-transaction.json'), 'utf8'));
const umi = createUmi(process.env.COOLBEARS_RPC_URL, { commitment: 'finalized', disableRetryOnRateLimit: true }).use(mplCore()).use(mplCandyMachine());
const rpc = async (method, params) => {
  const response = await fetch(process.env.COOLBEARS_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const data = await response.json();
  assert.ok(response.ok && !data.error && data.id === 1, `RPC read failed: ${method}`);
  return data.result;
};
assert.equal(await umi.rpc.getGenesisHash(), DEVNET);
const status = (await rpc('getSignatureStatuses', [[record.signature], { searchTransactionHistory: true }])).value[0];
const blockhashValid = (await rpc('isBlockhashValid', [record.blockhash, { commitment: 'finalized' }])).value;
const [rawAsset, rawCollection, rawMachine] = await umi.rpc.getAccounts([identities.mint, identities.collection, config.candyMachineId].map(address => publicKey(address)), { commitment: 'finalized' });
assert.ok(rawCollection.exists && rawMachine.exists);
const collection = deserializeCollectionV1(rawCollection);
const machine = deserializeCandyMachine(rawMachine);
const output = {
  checkedAt: new Date().toISOString(), cluster: 'devnet', production: false, transactionsSentByRecovery: 0,
  collection: collection.publicKey, candyMachine: machine.publicKey, asset: identities.mint,
  signature: record.signature, signatureStatus: status, blockhashValidAtFinalized: blockhashValid,
  assetExistsAtFinalized: rawAsset.exists, machineItems: Number(machine.data.itemsAvailable),
  loadedItems: machine.itemsLoaded, redeemedItems: Number(machine.itemsRedeemed),
  status: 'unresolved', physicalWalletVerified: false, magicEdenIndexed: false,
};
if (status?.confirmationStatus === 'finalized' && status.err === null && rawAsset.exists) {
  const asset = deserializeAssetV1(rawAsset);
  const guard = await fetchCandyGuard(umi, machine.mintAuthority);
  const expected = Object.values(makePreparation().assetCache.assetItems).slice(0, 2).find(item => item.jsonUri === asset.uri);
  assert.equal(asset.owner, policy.owner);
  assert.equal(asset.updateAuthority.type, 'Collection');
  assert.equal(asset.updateAuthority.address, collection.publicKey);
  assert.equal(machine.collectionMint, collection.publicKey);
  assert.equal(machine.data.itemsAvailable, 2n);
  assert.equal(machine.itemsRedeemed, 1n);
  assert.equal(machine.itemsLoaded, 2);
  assert.ok(expected);
  assert.equal(asset.name, expected.name);
  assert.equal(collection.royalties.basisPoints, 700);
  assert.equal(collection.royalties.creators[0].address, policy.owner);
  assert.equal(guard.guards.addressGate.value.address, identities.payer);
  assert.equal(guard.guards.solPayment.value.lamports.basisPoints, 500000000n);
  assert.equal(guard.guards.solPayment.value.destination, policy.owner);
  const transaction = await rpc('getTransaction', [record.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  assert.equal(transaction?.meta.err, null);
  const ownerIndex = transaction.transaction.message.accountKeys.indexOf(policy.owner);
  assert.ok(ownerIndex >= 0);
  const payment = transaction.meta.postBalances[ownerIndex] - transaction.meta.preBalances[ownerIndex];
  assert.equal(payment, 500000000);
  Object.assign(output, { status: 'verified-finalized', owner: asset.owner, name: asset.name, uri: asset.uri, paymentToOwnerLamports: payment, royaltyBasisPoints: collection.royalties.basisPoints, addressGateStillClosed: true });
  try { await writeFile(path.join(operation, 'finalized-recovery.json'), JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(path.join(operation, 'finalized-recovery.json'), 'utf8'));
    assert.equal(existing.signature, output.signature);
    assert.equal(existing.status, 'verified-finalized');
  }
} else if (status === null && blockhashValid === false && !rawAsset.exists && machine.itemsRedeemed === 0n) {
  output.status = 'expired-without-mint';
}
await writeFile(path.join(operation, `verification-${Date.now()}.json`), JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile('operator/reports/cli-devnet-mint-recovery.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
if (output.status !== 'verified-finalized') process.exitCode = 1;
