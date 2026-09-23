// Shared synthetic SDK account fixtures for grouped insertion tests. Never RPC evidence.
import { createHash } from 'node:crypto';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { some, none, lamports } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer, getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, CANDY_MACHINE_HIDDEN_SECTION, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID,
  findCandyMachineAuthorityPda, findCandyGuardPda, getCandyGuardAccountDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCollectionV1AccountDataSerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getAssetV1AccountDataSerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { getCandyMachineAccountDataSerializer } from '../../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { policy } from '../../prepare.mjs';

export function insertionAccounts(manifest, loaded = 0) {
  const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('NO_NETWORK'); } }).use(mplCandyMachine());
  const guardSerializer = getCandyGuardAccountDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*'));
  const [collectionExpected, reserveExpected, machineExpected] = manifest.steps.slice(0, 3).map(step => step.expected);
  const rpc = (bytes, owner) => ({ data: [Buffer.from(bytes).toString('base64'), 'base64'], owner, executable: false, lamports: 10000000000, space: bytes.length });
function coreBytes(base, plugins = []) {
  if (!plugins.length) return Buffer.from(base);
  const encoded = plugins.map(item => getPluginSerializer().serialize(item.plugin));
  let cursor = base.length + 9;
  const registry = plugins.map((item, index) => {
    const record = { pluginType: item.type, authority: item.authority, offset: BigInt(cursor) };
    cursor += encoded[index].length; return record;
  });
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: BigInt(cursor) });
  const registryBytes = getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1, registry, externalRegistry: [] });
  return Buffer.concat([base, header, ...encoded, registryBytes]);
}
function royalties(changes = {}) {
  return { type: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' },
    plugin: { __kind: 'Royalties', fields: [{ basisPoints: 700, creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' }, ...changes }] } };
}
function delegate(machine = machineExpected.machine) {
  return { type: PluginType.UpdateDelegate, authority: { __kind: 'UpdateAuthority' },
    plugin: { __kind: 'UpdateDelegate', fields: [{ additionalDelegates: [findCandyMachineAuthorityPda(umi, { candyMachine: machine })[0]] }] } };
}
function collectionFixture(expected = collectionExpected, changes = {}, plugins) {
  const count = expected.reservedAssetCreated ? 1 : 0;
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1, updateAuthority: expected.updateAuthority,
    name: expected.name, uri: expected.uri, numMinted: count, currentSize: count, ...changes });
  return rpc(coreBytes(base, plugins ?? [royalties(), ...(expected.machine ? [delegate(expected.machine)] : [])]), MPL_CORE_PROGRAM_ID);
}
function reserveFixture(changes = {}, plugins = []) {
  return rpc(coreBytes(getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1, owner: reserveExpected.owner,
    updateAuthority: { __kind: 'Collection', fields: [reserveExpected.collection] }, name: reserveExpected.name,
    uri: reserveExpected.uri, seq: none(), ...changes }), plugins), MPL_CORE_PROGRAM_ID);
}
function machineFixture(loaded = 0, changes = {}) {
  const settings = machineExpected.configLineSettings, N = machineExpected.itemsAvailable;
  const base = getCandyMachineAccountDataSerializer().serialize({ authority: machineExpected.authority, mintAuthority: machineExpected.mintAuthority,
    collectionMint: machineExpected.collection, itemsRedeemed: 0n,
    data: { itemsAvailable: BigInt(N), maxEditionSupply: 0n, isMutable: true, configLineSettings: some(settings), hiddenSettings: none() }, ...changes });
  const bytes = Buffer.alloc(machineExpected.machineSpace); bytes.set(base);
  bytes.writeUInt32LE(loaded, CANDY_MACHINE_HIDDEN_SECTION);
  const lineSize = settings.nameLength + settings.uriLength;
  const bitmap = CANDY_MACHINE_HIDDEN_SECTION + 4 + N * lineSize;
  const indices = bitmap + Math.floor(N / 8) + 1;
  for (let index = 0; index < loaded; index++) {
    const number = String(index + 1).padStart(4, '0');
    const offset = CANDY_MACHINE_HIDDEN_SECTION + 4 + index * lineSize;
    bytes.write(policy.hiddenName.replace('{index:04d}', number), offset, settings.nameLength, 'utf8');
    bytes.write(`${policy.website}/metadata/hidden/${number}.json`, offset + settings.nameLength, settings.uriLength, 'utf8');
    bytes[bitmap + Math.floor(index / 8)] |= 128 >> (index % 8);
    bytes.writeUInt32LE(index, indices + index * 4);
  }
  return rpc(bytes, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
}
function guardFixture(changes = {}) {
  const bytes = Buffer.from(guardSerializer.serialize({ base: machineExpected.machine, bump: findCandyGuardPda(umi, { base: machineExpected.machine })[1],
    authority: machineExpected.guardAuthority, guards: { addressGate: some({ address: policy.owner }),
      solPayment: some({ lamports: lamports(200000000), destination: policy.owner }) }, groups: [], ...changes }));
  // Rust #[account] CandyGuard; the hooked 0.3.0 SDK encoder has a wrong prefix.
  bytes.set(createHash('sha256').update('account:CandyGuard').digest().subarray(0, 8));
  return rpc(bytes, MPL_CORE_CANDY_GUARD_PROGRAM_ID);
}

  return [{ executable: true }, { executable: true }, { executable: true },
    collectionFixture({ ...collectionExpected, reservedAssetCreated: true, machine: machineExpected.machine }),
    reserveFixture(), machineFixture(loaded), guardFixture()];
}
