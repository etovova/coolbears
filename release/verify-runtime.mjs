// Local SVM execution of freshly downloaded official programs; not a Devnet result.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { generateSigner, signerIdentity, lamports, some } from '@metaplex-foundation/umi';
import { mplCore, fetchCollection, fetchAsset, transfer, update } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, fetchCandyMachine, fetchCandyGuard, findCandyGuardPda, mintV1, updateCandyGuard } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { policy, CLOSED_UNTIL, closedGuards, collectionBuilder, assetBuilder, machineBuilder } from './settings.mjs';

const vm = new LiteSVM();
const programReport = JSON.parse(await readFile(new URL('./reports/programs.json', import.meta.url), 'utf8'));
for (const program of programReport.programs) {
  const bytes = await readFile(new URL(`../private/programs/${program.program}.so`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), program.sha256);
  vm.addProgram(program.program, bytes);
}
const umi = createUmi('http://127.0.0.1:8899').use(mplCore()).use(mplCandyMachine());
// No HTTP calls: only the minimum RPC interface required by official builders.
const readAccount = async publicKey => {
  const account = vm.getAccount(publicKey);
  if (!account.exists) return { exists: false, publicKey };
  return { exists: true, publicKey, executable: account.executable, owner: account.programAddress,
    lamports: lamports(account.lamports), rentEpoch: 0n, data: Uint8Array.from(account.data) };
};
umi.rpc = new Proxy(umi.rpc, { get(target, key) {
  const local = {
    getCluster: () => 'devnet',
    getAccount: readAccount, getAccounts: keys => Promise.all(keys.map(readAccount)),
    getRent: async bytes => lamports(vm.minimumBalanceForRentExemption(BigInt(bytes))),
    getLatestBlockhash: async () => ({ blockhash: vm.latestBlockhash(), lastValidBlockHeight: 1000000n }),
    getBalance: async key => lamports(vm.getBalance(key) || 0n),
  };
  if (key in local) return local[key];
  if (typeof target[key] === 'function') return () => { throw Error(`Unexpected RPC in local test: ${String(key)}`); };
  return target[key];
} });
const payer = generateSigner(umi); umi.use(signerIdentity(payer));
assert.notEqual(payer.publicKey, policy.owner);
assert.ok(!(vm.airdrop(payer.publicKey, 10000000000n) instanceof FailedTransactionMetadata));
const collection = generateSigner(umi), item = generateSigner(umi), machine = generateSigner(umi);
const treasury = generateSigner(umi), minted = generateSigner(umi), recipient = generateSigner(umi);
const report = { checkedAt: new Date().toISOString(), scope: 'local LiteSVM only; no real Devnet or Phantom execution',
  passed: false, litesvm: '1.4.1', programSnapshot: programReport.checkedAt, checks: [], transactions: [] };
async function send(label, builder, expectedFailure) {
  vm.expireBlockhash();
  const tx = await builder.useLegacyVersion().setBlockhash(vm.latestBlockhash()).buildAndSign(umi);
  const bytes = umi.transactions.serialize(tx); assert.ok(bytes.length <= 1232, `${label}: packet size`);
  const result = vm.sendTransaction(getTransactionDecoder().decode(bytes));
  if (expectedFailure) {
    assert.ok(result instanceof FailedTransactionMetadata, `${label} should fail`);
    assert.match(result.meta().logs().join('\n'), expectedFailure); report.checks.push(label); return;
  }
  assert.ok(!(result instanceof FailedTransactionMetadata), `${label}: ${result instanceof FailedTransactionMetadata ? result.toString() : ''}`);
  report.transactions.push({ step: label, bytes: bytes.length, computeUnits: result.computeUnitsConsumed().toString() });
  report.checks.push(label);
}
try {
  await send('collection', collectionBuilder(umi, collection, { name: 'SDK VM test', owner: payer.publicKey }));
  const readCollection = () => fetchCollection(umi, collection.publicKey);
  assert.equal((await readCollection()).royalties.basisPoints, 700);
  await send('standalone-item', assetBuilder(umi, item, collection.publicKey, { owner: payer.publicKey, name: 'VM item', uri: `${policy.website}/metadata/0000.json` }));
  await send('machine-9999', await machineBuilder(umi, machine, collection.publicKey, { owner: payer.publicKey,
    treasury: treasury.publicKey, commitment: new Uint8Array(32).fill(7), uri: `${policy.website}/metadata/0000.json` }));
  assert.equal((await fetchCandyMachine(umi, machine.publicKey)).data.itemsAvailable, 9999n);
  const guard = findCandyGuardPda(umi, { base: machine.publicKey })[0];
  const mint = asset => setComputeUnitLimit(umi, { units: 400000 }).add(mintV1(umi, {
    candyMachine: machine.publicKey, candyGuard: guard, collection: collection.publicKey,
    asset, mintArgs: { solPayment: some({ destination: treasury.publicKey }) },
  }));
  await send('closed-mint-rejected', mint(minted), /MintNotLive|Mint not live/i);
  assert.equal((await fetchCandyMachine(umi, machine.publicKey)).itemsRedeemed, 0n);
  await send('open-lab-only', updateCandyGuard(umi, { candyGuard: guard,
    guards: { solPayment: closedGuards(treasury.publicKey).solPayment }, groups: [] }));
  await send('paid-mint', mint(minted));
  assert.equal(vm.getBalance(treasury.publicKey), 500000000n);
  assert.equal((await fetchAsset(umi, minted.publicKey)).owner, payer.publicKey);
  assert.equal((await fetchCandyMachine(umi, machine.publicKey)).itemsRedeemed, 1n);
  await send('same-asset-cannot-mint-twice', mint(minted), /MetadataAccountMustBeEmpty/);
  assert.equal(vm.getBalance(treasury.publicKey), 500000000n);
  await send('close-lab', updateCandyGuard(umi, { candyGuard: guard, guards: closedGuards(treasury.publicKey), groups: [] }));
  assert.equal((await fetchCandyGuard(umi, guard)).guards.startDate.value.date, CLOSED_UNTIL);
  await send('closed-again-rejects-mint', mint(generateSigner(umi)), /MintNotLive|Mint not live/i);
  await send('transfer', transfer(umi, { asset: await fetchAsset(umi, minted.publicKey), collection: await readCollection(), newOwner: recipient.publicKey }));
  assert.equal((await fetchAsset(umi, minted.publicKey)).owner, recipient.publicKey);
  await send('synthetic-metadata-update', update(umi, { asset: await fetchAsset(umi, item.publicKey), collection: await readCollection(), name: 'VM updated item' }));
  assert.equal((await fetchAsset(umi, item.publicKey)).name, 'VM updated item');
  assert.equal((await readCollection()).numMinted, 2);
  assert.equal((await fetchCandyMachine(umi, machine.publicKey)).itemsRedeemed, 1n);
  assert.equal(vm.getBalance(treasury.publicKey), 500000000n);
  report.checks.push('final collection size, payment, ownership and machine state'); report.passed = true;
} catch (error) {
  report.error = String(error.message); process.exitCode = 1;
} finally {
  await writeFile(new URL('./reports/runtime.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
