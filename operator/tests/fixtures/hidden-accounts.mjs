// Official SDK encodings for disposable Hidden Settings tests only.
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { some, none, lamports } from '@metaplex-foundation/umi';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer,
  getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, findCandyGuardPda, findCandyMachineAuthorityPda,
  getCandyGuardDataSerializer, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
  MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCandyMachineAccountDataSerializer as machineSerializer } from '../../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { getCandyGuardAccountDataSerializer as guardHeaderSerializer } from '../../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/accounts/candyGuard.js';
import { getCollectionV1AccountDataSerializer as collectionSerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer as registrySerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { resolveStorageProfile } from '../../storage-mode.mjs';

export const fixtureRpcAccount = (data, owner, rent = 10000000000) => ({ owner,
  executable: false, lamports: rent, space: data.length,
  data: [Buffer.from(data).toString('base64'), 'base64'] });

export function hiddenAccountFixtures({ policy, storageOptions, roles }) {
  const profile = resolveStorageProfile(policy, storageOptions);
  if (profile.storageMode !== 'hidden-settings') throw Error('HIDDEN_FIXTURE_PROFILE_REQUIRED');
  const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('NO_NETWORK'); } }).use(mplCandyMachine());
  const { machine, collection } = roles;
  const [guard, bump] = findCandyGuardPda(umi, { base: machine });
  const expected = { machine, guard, collection, authority: policy.owner, guardAuthority: policy.owner,
    mintAuthority: guard, itemsAvailable: policy.supply - 1, itemsLoaded: 0,
    machineSpace: 652, machineRentLamports: '3962400', configLineSettings: null,
    storageMode: storageOptions.storageMode, hiddenSettings: profile.hiddenSettings,
    addressGate: policy.owner, payment: { lamports: String(policy.priceSol * 1e9), destination: policy.owner }, salesOpen: false };
  function machineAccount(redeemed = 0, changes = {}, extraBytes = 0) {
    const base = machineSerializer().serialize({ authority: policy.owner, mintAuthority: guard,
      collectionMint: collection, itemsRedeemed: BigInt(redeemed), data: {
        itemsAvailable: BigInt(policy.supply - 1), maxEditionSupply: 0n, isMutable: true,
        configLineSettings: none(), hiddenSettings: some({ ...profile.hiddenSettings,
          hash: new Uint8Array(Buffer.from(profile.hiddenSettings.hash, 'hex')) }), ...changes } });
    const bytes = Buffer.alloc(652 + extraBytes); bytes.set(base);
    return fixtureRpcAccount(bytes, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  }
  function guardAccount(payment = BigInt(expected.payment.lamports), recipient = policy.owner) {
    const header = guardHeaderSerializer().serialize({ base: machine, bump, authority: policy.owner });
    const encoded = getCandyGuardDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*')).serialize({
      guards: { addressGate: some({ address: policy.owner }),
        solPayment: some({ lamports: lamports(payment), destination: recipient }) }, groups: [] });
    return fixtureRpcAccount(Buffer.concat([header, encoded]), MPL_CORE_CANDY_GUARD_PROGRAM_ID);
  }
  function collectionAccount(redeemed) {
    const base = collectionSerializer().serialize({ key: Key.CollectionV1, updateAuthority: policy.owner,
      name: policy.collectionName, uri: `${policy.website}/metadata/collection.json`,
      numMinted: redeemed + 1, currentSize: redeemed + 1 });
    const plugins = [
      { type: PluginType.Royalties, plugin: { __kind: 'Royalties', fields: [{ basisPoints: policy.royaltyPercent * 100,
        creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] } },
      { type: PluginType.UpdateDelegate, plugin: { __kind: 'UpdateDelegate', fields: [{
        additionalDelegates: [findCandyMachineAuthorityPda(umi, { candyMachine: machine })[0]] }] } },
    ];
    const encoded = plugins.map(value => getPluginSerializer().serialize(value.plugin));
    let cursor = base.length + 9;
    const records = plugins.map((value, index) => { const record = { pluginType: value.type,
      authority: { __kind: 'UpdateAuthority' }, offset: BigInt(cursor) }; cursor += encoded[index].length; return record; });
    const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: BigInt(cursor) });
    const registry = registrySerializer().serialize({ key: Key.PluginRegistryV1, registry: records, externalRegistry: [] });
    return fixtureRpcAccount(Buffer.concat([base, header, ...encoded, registry]), MPL_CORE_PROGRAM_ID);
  }
  return { profile, expected, machineAccount, guardAccount, collectionAccount, guard };
}
