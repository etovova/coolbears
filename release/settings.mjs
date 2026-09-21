import { publicKey, some, none, lamports } from '@metaplex-foundation/umi';
import { createCollection, create as createAsset } from '@metaplex-foundation/mpl-core';
import { create as createMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import policy from '../metadata/policy.json' with { type: 'json' };

export { policy };
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const CLOSED_UNTIL = 4102444800n; // Administrative stop, not the reveal date.

export function royalties(owner = policy.owner) {
  return {
    type: 'Royalties', basisPoints: policy.royaltyPercent * 100,
    creators: [{ address: publicKey(owner), percentage: 100 }],
    ruleSet: { __kind: 'None' },
  };
}

export function closedGuards(treasury = policy.owner) {
  return {
    solPayment: some({ lamports: lamports(BigInt(policy.priceSol * 1e9)), destination: publicKey(treasury) }),
    startDate: some({ date: CLOSED_UNTIL }),
  };
}

export function collectionBuilder(umi, collection, { name = policy.collectionName,
  uri = `${policy.website}/metadata/collection.json`, owner = policy.owner } = {}) {
  return createCollection(umi, {
    collection, name, uri, updateAuthority: publicKey(owner), plugins: [royalties(owner)],
  });
}

export function assetBuilder(umi, asset, collection, { name, uri, owner = policy.owner }) {
  if (!name || !uri) throw Error('Asset metadata required');
  return createAsset(umi, { asset, collection: { publicKey: collection }, name, uri, owner: publicKey(owner) });
}

export async function machineBuilder(umi, machine, collection, { commitment,
  uri, name = 'CoolBears #$ID+1$ — Hidden Bear', owner = policy.owner,
  treasury = policy.owner, itemsAvailable = policy.supply - 1 } = {}) {
  if (!(commitment instanceof Uint8Array) || commitment.length !== 32) throw Error('32-byte reveal commitment required');
  if (!uri || !uri.startsWith('https://')) throw Error('HTTPS hidden metadata URI required');
  if (umi.identity.publicKey !== publicKey(owner)) throw Error('Collection authority must sign');
  if (!Number.isSafeInteger(itemsAvailable) || itemsAvailable < 1 || itemsAvailable >= policy.supply) throw Error('Invalid public supply');
  return createMachine(umi, {
    candyMachine: machine, collection, collectionUpdateAuthority: umi.identity,
    authority: publicKey(owner), itemsAvailable, isMutable: true,
    configLineSettings: none(), hiddenSettings: some({ name, uri, hash: commitment }),
    guards: closedGuards(treasury),
  });
}
