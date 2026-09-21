import { none, some, sol, transactionBuilder, publicKey } from '@metaplex-foundation/umi';
import { createCollection, create as createAsset, update, ruleSet } from '@metaplex-foundation/mpl-core';
import { create, mintV1, updateCandyGuard, findCandyGuardPda } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit, setComputeUnitPrice } from '@metaplex-foundation/mpl-toolbox';
import { SPEC, CLOSED_DATE, validateCommitment, assertRevealTime, indexFromName } from './spec.mjs';

export function guards(owner, open = false) {
  return { solPayment: some({ lamports: sol(0.5), destination: publicKey(owner) }), startDate: some({ date: open ? 0n : CLOSED_DATE }) };
}
export function budget(umi, builder) {
  // Bounded priority fee: at most 8000 lamports per transaction.
  return transactionBuilder().add(setComputeUnitLimit(umi, { units: 800000 }))
    .add(setComputeUnitPrice(umi, { microLamports: 10000 })).add(builder);
}
export function buildCollection(umi, collection) {
  return budget(umi, createCollection(umi, { collection, name: 'CoolBears', uri: SPEC.collectionUri,
    plugins: [{ type: 'Royalties', basisPoints: SPEC.royaltyBps,
      creators: [{ address: umi.identity.publicKey, percentage: 100 }], ruleSet: ruleSet('None') }] }));
}
export function buildReserved(umi, asset, collection) {
  return budget(umi, createAsset(umi, { asset, collection: { publicKey: publicKey(collection) },
    owner: umi.identity.publicKey, name: 'CoolBears #0000 — Hidden Bear', uri: SPEC.reservedUri }));
}
export async function buildMachine(umi, candyMachine, collection, commitment) {
  return budget(umi, await create(umi, { candyMachine, collection: publicKey(collection),
    collectionUpdateAuthority: umi.identity, itemsAvailable: SPEC.publicSupply,
    isMutable: true, maxEditionSupply: 0, configLineSettings: none(),
    hiddenSettings: some({ name: SPEC.hiddenName, uri: SPEC.hiddenUri, hash: validateCommitment(commitment) }),
    guards: guards(umi.identity.publicKey), groups: [] }));
}
export function buildSaleState(umi, machine, owner, open) {
  if (umi.identity.publicKey !== owner) throw Error('Collection owner required');
  return budget(umi, updateCandyGuard(umi, { candyGuard: findCandyGuardPda(umi, { base: publicKey(machine) }),
    guards: guards(owner, open), groups: [] }));
}
export function buildMint(umi, asset, machine, collection, owner) {
  return budget(umi, mintV1(umi, { asset, candyMachine: publicKey(machine), collection: publicKey(collection),
    mintArgs: { solPayment: some({ destination: publicKey(owner) }) } }));
}
export function buildReveal(umi, asset, collection, item, chainTime) {
  assertRevealTime(chainTime);
  if (indexFromName(asset.name) !== item.index || item.name !== `CoolBears #${String(item.index).padStart(4, '0')}`) throw Error('Reveal asset index mismatch');
  if (asset.updateAuthority.type !== 'Collection' || asset.updateAuthority.address !== collection.publicKey) throw Error('Asset is outside this collection');
  return budget(umi, update(umi, { asset, collection, authority: umi.identity, name: item.name, uri: item.uri }));
}
