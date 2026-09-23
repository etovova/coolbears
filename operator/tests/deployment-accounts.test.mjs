// Synthetic account data built with official SDK serializers. No RPC or keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { some, none, lamports } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer, getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, CANDY_MACHINE_HIDDEN_SECTION, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID,
  findCandyMachineAuthorityPda, findCandyGuardPda, getCandyGuardAccountDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { getCandyMachineAccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan } from '../deployment/plan.mjs';
import { expectedAccountAddresses, verifyExpectedAccounts } from '../deployment/accounts.mjs';

const address = byte => base58.deserialize(new Uint8Array(32).fill(byte))[0];
const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('NO_NETWORK'); } }).use(mplCandyMachine());
const guardSerializer = getCandyGuardAccountDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*'));
const plan = await buildDeploymentPlan({ cluster: 'devnet', collection: address(20), reservedAsset: address(21), machine: address(22),
  blockhash: address(23), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
const [collectionExpected, reserveExpected, machineExpected, insertExpected] = plan.steps.slice(0, 4).map(step => step.expected);
const safeError = error => error.code === 'EXPECTED_ACCOUNT_STATE_MISMATCH' && error.message === 'EXPECTED_ACCOUNT_STATE_MISMATCH';
const rpc = (bytes, owner) => ({ data: [Buffer.from(bytes).toString('base64'), 'base64'], owner, executable: false, lamports: 10000000000, space: bytes.length });
const bytesOf = value => Buffer.from(value.data[0], 'base64');
const check = (expected, values) => verifyExpectedAccounts(expected, expectedAccountAddresses(expected), values);
const deny = (expected, values) => assert.throws(() => check(expected, values), safeError);

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
  return rpc(guardSerializer.serialize({ base: machineExpected.machine, bump: findCandyGuardPda(umi, { base: machineExpected.machine })[1],
    authority: machineExpected.guardAuthority, guards: { addressGate: some({ address: policy.owner }),
      solPayment: some({ lamports: lamports(200000000), destination: policy.owner }) }, groups: [], ...changes }), MPL_CORE_CANDY_GUARD_PROGRAM_ID);
}
function corrupt(account, mutate) {
  const bytes = bytesOf(account); mutate(bytes);
  return { ...account, data: [bytes.toString('base64'), 'base64'] };
}

test('addresses bind exact expected profiles and positional RPC accounts', () => {
  assert.deepEqual(expectedAccountAddresses(collectionExpected), [collectionExpected.collection]);
  assert.deepEqual(expectedAccountAddresses(reserveExpected), [reserveExpected.asset]);
  assert.deepEqual(expectedAccountAddresses(machineExpected), [machineExpected.machine, machineExpected.guard]);
  assert.deepEqual(expectedAccountAddresses(insertExpected), [insertExpected.machine]);
  assert.throws(() => verifyExpectedAccounts(machineExpected, [machineExpected.guard, machineExpected.machine], [guardFixture(), machineFixture()]), safeError);
  assert.throws(() => verifyExpectedAccounts(collectionExpected, [reserveExpected.asset], [collectionFixture()]), safeError);
  for (const expected of [null, {}, { ...collectionExpected, rawSecret: 'never expose' }, { ...collectionExpected, reservedAssetCreated: false }]) {
    assert.throws(() => expectedAccountAddresses(expected), safeError);
  }
});

test('fresh collection verifies exact owner, metadata, royalties and zero counters', () => {
  assert.equal(check(collectionExpected, [collectionFixture()]), true);
  for (const changes of [{ key: Key.AssetV1 }, { updateAuthority: address(88) }, { name: 'different' }, { uri: 'https://bad.example/' },
    { numMinted: 1, currentSize: 1 }, { numMinted: 1 }, { currentSize: 1 }]) deny(collectionExpected, [collectionFixture(collectionExpected, changes)]);
  for (const changes of [{ basisPoints: 0 }, { creators: [{ address: address(88), percentage: 100 }] },
    { creators: [{ address: policy.owner, percentage: 99 }] }, { ruleSet: { __kind: 'ProgramAllowList', fields: [[address(88)]] } }]) {
    deny(collectionExpected, [collectionFixture(collectionExpected, {}, [royalties(changes)])]);
  }
  const wrongAuthority = royalties(); wrongAuthority.authority = { __kind: 'Address', address: policy.owner };
  deny(collectionExpected, [collectionFixture(collectionExpected, {}, [wrongAuthority])]);
  deny(collectionExpected, [collectionFixture(collectionExpected, {}, [royalties(), delegate()])]);
});

test('after reserve and machine, only one reserved NFT and exact official CM delegate are permitted', () => {
  const afterReserve = { ...collectionExpected, reservedAssetCreated: true };
  assert.equal(check(afterReserve, [collectionFixture(afterReserve)]), true);
  deny(afterReserve, [collectionFixture(afterReserve, { numMinted: 0, currentSize: 0 })]);
  deny(afterReserve, [collectionFixture(afterReserve, { numMinted: 2, currentSize: 2 })]);
  const afterMachine = { ...afterReserve, machine: machineExpected.machine };
  assert.equal(check(afterMachine, [collectionFixture(afterMachine)]), true);
  deny(afterMachine, [collectionFixture(afterMachine, {}, [royalties()])]);
  deny(afterMachine, [collectionFixture(afterMachine, {}, [royalties(), delegate(address(88))])]);
  const extraDelegate = delegate(); extraDelegate.plugin.fields[0].additionalDelegates.push(address(88));
  deny(afterMachine, [collectionFixture(afterMachine, {}, [royalties(), extraDelegate])]);
  const wrongAuthority = delegate(); wrongAuthority.authority = { __kind: 'Address', address: findCandyMachineAuthorityPda(umi, { candyMachine: machineExpected.machine })[0] };
  deny(afterMachine, [collectionFixture(afterMachine, {}, [royalties(), wrongAuthority])]);
});

test('Core registry rejects unknown plugin types, invalid offsets, extra bytes and discriminator changes', () => {
  const fixture = collectionFixture();
  const baseLength = getCollectionV1AccountDataSerializer().deserialize(bytesOf(fixture))[1];
  const registryOffset = Number(bytesOf(fixture).readBigUInt64LE(baseLength + 1));
  for (const mutate of [
    bytes => { bytes[baseLength] = Key.Uninitialized; },
    bytes => { bytes.writeBigUInt64LE(1n, baseLength + 1); },
    bytes => { bytes[registryOffset] = Key.AssetV1; },
    bytes => { bytes[registryOffset + 5] = 255; },
    bytes => { bytes.writeUInt32LE(0xffffffff, registryOffset + 1); },
    bytes => { bytes.writeBigUInt64LE(0n, registryOffset + 7); },
    bytes => { bytes.writeUInt32LE(1, bytes.length - 4); },
  ]) deny(collectionExpected, [corrupt(fixture, mutate)]);
  const truncated = bytesOf(fixture).subarray(0, bytesOf(fixture).length - 1);
  deny(collectionExpected, [rpc(truncated, MPL_CORE_PROGRAM_ID)]);
  deny(collectionExpected, [rpc(Buffer.concat([bytesOf(fixture), Buffer.from([0])]), MPL_CORE_PROGRAM_ID)]);
});

test('reserve requires exact Core owner, collection update authority, #0000 metadata and no asset plugins', () => {
  assert.equal(check(reserveExpected, [reserveFixture()]), true);
  for (const changes of [{ key: Key.CollectionV1 }, { owner: address(88) }, { updateAuthority: { __kind: 'Address', fields: [reserveExpected.collection] } },
    { updateAuthority: { __kind: 'Collection', fields: [address(88)] } }, { name: 'CoolBears #0001 — Hidden Bear' }, { uri: `${policy.website}/metadata/hidden/0001.json` }]) {
    deny(reserveExpected, [reserveFixture(changes)]);
  }
  deny(reserveExpected, [reserveFixture({}, [delegate()])]);
});

test('machine creation verifies all authorities, closed guards, account allocation and unminted state', () => {
  assert.equal(check(machineExpected, [machineFixture(), guardFixture()]), true);
  for (const changes of [{ authority: address(88) }, { mintAuthority: address(88) }, { collectionMint: address(88) }, { itemsRedeemed: 1n }]) {
    deny(machineExpected, [machineFixture(0, changes), guardFixture()]);
  }
  const wrongData = { itemsAvailable: 2n, maxEditionSupply: 0n, isMutable: true, configLineSettings: some(machineExpected.configLineSettings), hiddenSettings: none() };
  deny(machineExpected, [machineFixture(0, { data: wrongData }), guardFixture()]);
  deny(machineExpected, [corrupt(machineFixture(), bytes => { bytes[0] ^= 1; }), guardFixture()]);
  deny(machineExpected, [{ ...machineFixture(), lamports: 1 }, guardFixture()]);
  deny(machineExpected, [rpc(bytesOf(machineFixture()).subarray(0, -8), MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID), guardFixture()]);
});

test('loaded prefix has exact counter, bitmap, clean unused area and correct mint indices', () => {
  const loaded = insertExpected.count;
  const expected = { ...machineExpected, itemsLoaded: loaded };
  const fixture = machineFixture(loaded);
  assert.equal(check(expected, [fixture, guardFixture()]), true);
  deny(machineExpected, [fixture, guardFixture()]);
  const bitmap = CANDY_MACHINE_HIDDEN_SECTION + 4 + machineExpected.itemsAvailable * (machineExpected.configLineSettings.nameLength + machineExpected.configLineSettings.uriLength);
  const indices = bitmap + Math.floor(machineExpected.itemsAvailable / 8) + 1;
  for (const mutate of [
    bytes => { bytes.writeUInt32LE(loaded + 1, CANDY_MACHINE_HIDDEN_SECTION); },
    bytes => { bytes[bitmap] ^= 128; },
    bytes => { bytes[bitmap + 1] |= 128; },
    bytes => { bytes[indices - 1] |= 1; },
    bytes => { bytes.writeUInt32LE(999, indices + 4); },
    bytes => { bytes[bytes.length - 1] = 1; },
    bytes => { bytes[CANDY_MACHINE_HIDDEN_SECTION - 1] = 1; },
    bytes => { bytes[CANDY_MACHINE_HIDDEN_SECTION + 4 + loaded * (machineExpected.configLineSettings.nameLength + machineExpected.configLineSettings.uriLength)] = 1; },
  ]) deny(expected, [corrupt(fixture, mutate), guardFixture()]);
});

test('guard must be canonical Core guard with exact base/bump/authority/payment and no additional guards/groups', () => {
  for (const changes of [{ base: address(88) }, { authority: address(88) }, { bump: 0 }, { groups: [{ label: 'other', guards: {} }] },
    { guards: { addressGate: some({ address: address(88) }), solPayment: some({ lamports: lamports(200000000), destination: policy.owner }) } },
    { guards: { addressGate: some({ address: policy.owner }), solPayment: some({ lamports: lamports(1), destination: policy.owner }) } },
    { guards: { addressGate: some({ address: policy.owner }), solPayment: some({ lamports: lamports(200000000), destination: address(88) }) } },
    { guards: { addressGate: some({ address: policy.owner }), solPayment: some({ lamports: lamports(200000000), destination: policy.owner }), botTax: some({ lamports: lamports(1), lastInstruction: true }) } },
  ]) deny(machineExpected, [machineFixture(), guardFixture(changes)]);
  deny(machineExpected, [machineFixture(), corrupt(guardFixture(), bytes => { bytes[0] ^= 1; })]);
  deny(machineExpected, [machineFixture(), rpc(Buffer.concat([bytesOf(guardFixture()), Buffer.from([0])]), MPL_CORE_CANDY_GUARD_PROGRAM_ID)]);
});

test('insert checks actual requested indices and exact padded UTF8 bytes, never just SDK decoded names', () => {
  const fixture = machineFixture(insertExpected.count);
  assert.equal(check(insertExpected, [fixture]), true);
  deny(insertExpected, [machineFixture(insertExpected.count - 1)]);
  for (const mutate of [
    bytes => { bytes[CANDY_MACHINE_HIDDEN_SECTION + 4] = 0; },
    bytes => { bytes[CANDY_MACHINE_HIDDEN_SECTION + 4 + machineExpected.configLineSettings.nameLength] ^= 1; },
  ]) deny(insertExpected, [corrupt(fixture, mutate)]);
  const following = plan.steps.find(step => step.id === 'insert-0001').expected;
  assert.equal(check(following, [machineFixture(following.startingIndex + following.count)]), true);
  deny(following, [fixture]);
});

test('RPC envelopes fail closed with fixed redacted errors for absence, wrong owner, executable or encoding', () => {
  const original = collectionFixture();
  for (const value of [null, {}, { ...original, owner: address(88) }, { ...original, executable: true },
    { ...original, lamports: Number.MAX_SAFE_INTEGER + 1 }, { ...original, lamports: 0 },
    { ...original, data: [original.data[0], 'base64+zstd'] }, { ...original, data: [original.data[0] + '\nsecret', 'base64'] },
    { ...original, space: original.space + 1 }, { ...original, data: ['sensitive invalid account', 'base64'] },
  ]) deny(collectionExpected, [value]);
  deny(collectionExpected, []); deny(collectionExpected, [original, original]);
});

test('verification never calls fetch and full final prefix remains bounded to official 9999 items', () => {
  const before = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw Error('NO_NETWORK'); };
  try {
    assert.equal(check({ ...machineExpected, itemsLoaded: 9999 }, [machineFixture(9999), guardFixture()]), true);
    const final = plan.steps.at(-1).expected;
    assert.equal(check(final, [machineFixture(9999)]), true);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = before; }
});
