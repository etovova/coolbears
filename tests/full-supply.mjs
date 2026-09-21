import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { fetchCollection, fetchAsset } from '@metaplex-foundation/mpl-core';
import { fetchCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { environment } from './svm.mjs';
import { buildCollection, buildReserved, buildMachine, buildSaleState, buildMint, buildReveal } from '../chain/builders.mjs';
import { SPEC, commitmentFor } from '../chain/spec.mjs';

const map = JSON.parse(await readFile(process.argv[2], 'utf8'));
const commitment = await commitmentFor(map);
const { svm, umi, owner, buyer, send } = environment();
const collection = generateSigner(umi), machine = generateSigner(umi), reserved = generateSigner(umi);
await send(buildCollection(umi, collection));
await send(buildReserved(umi, reserved, collection.publicKey));
await send(await buildMachine(umi, machine, collection.publicKey, commitment));
await send(buildSaleState(umi, machine.publicKey, owner.publicKey, true));
umi.use(signerIdentity(buyer));
const treasuryBefore = svm.getBalance(owner.publicKey);
const assets = [reserved.publicKey];
let maxBytes = 0;
for (let i = 1; i < SPEC.supply; i++) {
  const asset = generateSigner(umi);
  maxBytes = Math.max(maxBytes, (await send(buildMint(umi, asset, machine.publicKey, collection.publicKey, owner.publicKey))).bytes);
  const item = await fetchAsset(umi, asset.publicKey);
  assert.equal(item.name, `CoolBears #${i} — Hidden Bear`);
  assert.equal(item.uri, `https://coolbears-nfts.com/metadata/mint/${i}.json`);
  assert.equal(item.owner, buyer.publicKey);
  assets.push(asset.publicKey);
  if (i % 1000 === 0) console.log(`Minted and verified ${i}/9999`);
}
assert.equal(svm.getBalance(owner.publicKey) - treasuryBefore, SPEC.priceLamports * 9999n);
await send(buildMint(umi, generateSigner(umi), machine.publicKey, collection.publicKey, owner.publicKey), true);
assert.equal((await fetchCandyMachine(umi, machine.publicKey)).itemsRedeemed, 9999n);
const col = await fetchCollection(umi, collection.publicKey);
assert.equal(col.numMinted, 10000);
assert.equal(col.currentSize, 10000);
umi.use(signerIdentity(owner));
const revealed = [];
for (let i = 0; i < SPEC.supply; i++) {
  const asset = await fetchAsset(umi, assets[i]);
  await send(buildReveal(umi, asset, col, map[i], SPEC.revealNotBefore));
  const final = await fetchAsset(umi, assets[i]);
  assert.equal(final.owner, i === 0 ? owner.publicKey : buyer.publicKey);
  revealed.push({ index: i, name: final.name, uri: final.uri });
  if ((i + 1) % 1000 === 0) console.log(`Revealed and verified ${i + 1}/10000`);
}
assert.equal(await commitmentFor(revealed), commitment);
const report = { environment: 'LiteSVM with actual Devnet Metaplex binaries; no live wallet',
  publicMints: 9999, ownerAssets: 1, collectionSize: 10000, revealed: 10000,
  paymentLamports: String(SPEC.priceLamports * 9999n), supplyCapVerified: true,
  revealCommitmentVerified: true, maxMintTransactionBytes: maxBytes };
await writeFile('private/full-supply-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
