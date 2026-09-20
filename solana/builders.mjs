import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey, some } from '@metaplex-foundation/umi';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { mplCore, createCollection } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, create, addConfigLines, mintV1 } from '@metaplex-foundation/mpl-core-candy-machine';

export const DEVNET_RPC = 'https://devnet.rpcpool.com';
export const SITE = 'https://coolbears-nfts.com';
export const TEST_SUPPLY = 2;
export const configLineSettings = {
  prefixName: 'CoolBears #', nameLength: 20,
  prefixUri: `${SITE}/metadata/hidden/`, uriLength: 9,
  isSequential: true
};
export function devnetUmi(provider, rpcOptions = {}) {
  const umi = createUmi(DEVNET_RPC, { ...rpcOptions, commitment: 'confirmed' }).use(mplCore()).use(mplCandyMachine());
  if (provider) umi.use(walletAdapterIdentity(provider));
  return umi;
}
export function assertDevnet(umi) {
  if (umi.rpc.getEndpoint() !== DEVNET_RPC) throw new Error('This workflow is Devnet only');
}
export function collectionBuilder(umi, collection) {
  assertDevnet(umi);
  return createCollection(umi, {
    collection, name: 'CoolBears', uri: `${SITE}/metadata/collection.json`,
    updateAuthority: umi.identity.publicKey,
    plugins: [{ type: 'Royalties', basisPoints: 700,
      creators: [{ address: umi.identity.publicKey, percentage: 100 }],
      ruleSet: { type: 'None' } }]
  });
}
export async function testMachineBuilder(umi, candyMachine, collection) {
  assertDevnet(umi);
  return create(umi, {
    candyMachine, collection: publicKey(collection), collectionUpdateAuthority: umi.identity,
    itemsAvailable: TEST_SUPPLY, isMutable: true, configLineSettings: some(configLineSettings),
    guards: { addressGate: some({ address: umi.identity.publicKey }) }
  });
}
export function testItemsBuilder(umi, candyMachine) {
  assertDevnet(umi);
  return addConfigLines(umi, {
    candyMachine: publicKey(candyMachine), index: 0,
    configLines: Array.from({ length: TEST_SUPPLY }, (_, i) => ({ name: `${String(i).padStart(4, '0')} — Hidden Bear`, uri: `${String(i).padStart(4, '0')}.json` }))
  });
}
export function testMintBuilder(umi, candyMachine, collection, asset) {
  assertDevnet(umi);
  return mintV1(umi, { candyMachine: publicKey(candyMachine), collection: publicKey(collection), asset });
}
