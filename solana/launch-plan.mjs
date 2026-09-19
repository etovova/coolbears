// Unsigned launch preparation. This module never signs or sends transactions.
import { publicKey, some, lamports } from '@metaplex-foundation/umi';
import { createCollection, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID, create, addConfigLines, mintV1, updateCandyGuard, findCandyGuardPda, fetchCandyMachine, fetchCandyGuard } from '@metaplex-foundation/mpl-core-candy-machine';
import { fetchCollection, fetchAsset } from '@metaplex-foundation/mpl-core';
import { configLineSettings, SITE } from './builders.mjs';
export const LAUNCH_OWNER = 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
export const SUPPLY = 10000;
export const PRICE = 500000000n;
export function launchPlan({ treasury, royaltyRecipient }) {
  // Destinations must be explicit; no hidden fallback in transaction builders.
  if (!treasury || !royaltyRecipient) throw Error('Specify payment and royalty destinations.');
  return Object.freeze({ owner: LAUNCH_OWNER, treasury: publicKey(treasury), royaltyRecipient: publicKey(royaltyRecipient) });
}
function authority(umi, plan) {
  if (plan.owner !== LAUNCH_OWNER || umi.identity.publicKey !== LAUNCH_OWNER) throw Error('Launch authority mismatch.');
}
export const reservedGuards = () => ({ addressGate: some({ address: publicKey(LAUNCH_OWNER) }), redeemedAmount: some({ maximum: 1n }) });
export const paidGuards = plan => ({ solPayment: some({ lamports: lamports(PRICE), destination: plan.treasury }) });
export function launchCollectionBuilder(umi, plan, collection) {
  authority(umi, plan);
  return createCollection(umi, { collection, name: 'CoolBears', uri: `${SITE}/metadata/collection.json`, updateAuthority: publicKey(plan.owner), plugins: [{ type: 'Royalties', basisPoints: 700, creators: [{ address: plan.royaltyRecipient, percentage: 100 }], ruleSet: { type: 'None' } }] });
}
export async function launchMachineBuilder(umi, plan, machine, collection) {
  authority(umi, plan);
  return create(umi, { candyMachine: machine, collection: publicKey(collection), collectionUpdateAuthority: umi.identity, itemsAvailable: SUPPLY, isMutable: true, configLineSettings: some(configLineSettings), guards: reservedGuards(), groups: [] });
}
export function launchItemsBuilder(umi, plan, machine, start, count = 25) {
  authority(umi, plan);
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || count > 25 || start + count > SUPPLY) throw Error('Invalid config-line batch.');
  const builder = addConfigLines(umi, { candyMachine: publicKey(machine), index: start, configLines: Array.from({ length: count }, (_, offset) => { const id = String(start + offset).padStart(4,'0'); return { name: `${id} — Hidden Bear`, uri: `${id}.json` }; }) });
  if (!builder.fitsInOneTransaction(umi)) throw Error('Config batch exceeds transaction size.');
  return builder;
}
export function inspectReservedLaunch(plan, { collection, machine, guard, asset }) {
  if (collection.header?.owner !== MPL_CORE_PROGRAM_ID || asset.header?.owner !== MPL_CORE_PROGRAM_ID || machine.header?.owner !== MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID || guard.header?.owner !== MPL_CORE_CANDY_GUARD_PROGRAM_ID) throw Error('Unexpected account program.');
  if (collection.updateAuthority !== plan.owner || collection.name !== 'CoolBears' || collection.uri !== `${SITE}/metadata/collection.json`) throw Error('Collection mismatch.');
  const royalty = collection.royalties;
  if (royalty?.basisPoints !== 700 || royalty.creators?.length !== 1 || royalty.creators[0].address !== plan.royaltyRecipient || royalty.creators[0].percentage !== 100) throw Error('Royalty mismatch.');
  if (machine.authority !== plan.owner || machine.collectionMint !== collection.publicKey || machine.data.itemsAvailable !== 10000n || !machine.data.isMutable || machine.itemsLoaded !== SUPPLY || machine.itemsRedeemed !== 1n) throw Error('Machine not ready.');
  const settings = machine.data.configLineSettings;
  if (settings.__option !== 'Some' || Object.entries(configLineSettings).some(([k,v]) => settings.value[k] !== v)) throw Error('Sequential config mismatch.');
  if (machine.items?.length !== SUPPLY) throw Error('Missing loaded items.');
  for (let i=0;i<SUPPLY;i++) {
    const item = machine.items[i], id=String(i).padStart(4,'0');
    if (item.index !== i || item.name !== `CoolBears #${id} — Hidden Bear` || item.uri !== `${SITE}/metadata/hidden/${id}.json` || item.minted !== (i===0)) throw Error(`Config line mismatch at ${i}.`);
  }
  if (guard.publicKey !== machine.mintAuthority || guard.authority !== plan.owner || guard.groups.length !== 0 || guard.guards.addressGate?.value?.address !== plan.owner || guard.guards.redeemedAmount?.value?.maximum !== 1n) throw Error('Reservation guards mismatch.');
  for (const [key,value] of Object.entries(guard.guards)) if (!['addressGate','redeemedAmount'].includes(key) && value.__option !== 'None') throw Error('Unexpected guard.');
  if (asset.owner !== plan.owner || asset.name !== 'CoolBears #0000 — Hidden Bear' || asset.uri !== `${SITE}/metadata/hidden/0000.json` || asset.updateAuthority.type !== 'Collection' || asset.updateAuthority.address !== collection.publicKey) throw Error('Owner #0000 has not been verified.');
  if (collection.currentSize !== 1 || collection.numMinted !== 1) throw Error('Unexpected collection inventory.');
  return true;
}
export async function publicOpeningBuilder(umi, plan, addresses) {
  authority(umi, plan);
  if (await umi.rpc.call('getGenesisHash',[]) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('Public opening requires Mainnet.');
  const options = {commitment:'finalized'};
  const [collection,machine,asset] = await Promise.all([fetchCollection(umi,publicKey(addresses.collection),options),fetchCandyMachine(umi,publicKey(addresses.machine),options),fetchAsset(umi,publicKey(addresses.reservedAsset),options)]);
  const expectedGuard = findCandyGuardPda(umi,{base:machine.publicKey})[0];
  if (machine.mintAuthority !== expectedGuard) throw Error('Unexpected Candy Guard address.');
  const guard = await fetchCandyGuard(umi,expectedGuard,options);
  inspectReservedLaunch(plan,{collection,machine,guard,asset});
  return updateCandyGuard(umi,{candyGuard:expectedGuard,authority:umi.identity,guards:paidGuards(plan),groups:[]});
}
export function paidMintBuilder(umi, plan, {machine,collection,asset}) {
  return mintV1(umi,{candyMachine:publicKey(machine),collection:publicKey(collection),asset,mintArgs:{solPayment:some({destination:plan.treasury})}});
}
export function orderPrice(quantity) {
  if (!Number.isInteger(quantity) || quantity<1 || quantity>50) throw Error('Choose 1–50 NFT per order.');
  return PRICE*BigInt(quantity);
}
