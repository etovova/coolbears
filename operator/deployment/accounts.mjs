// Pure verification of supplied RPC account values for this fixed deployment
// profile. Network/finality and transaction identity are the caller's job.
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { lamports, some } from '@metaplex-foundation/umi';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer,
  getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer as collectionSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getAssetV1AccountDataSerializer as assetSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getRegistryRecordSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/registryRecord.js';
import { getCandyMachineAccountDataSerializer as machineBaseSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { getCandyGuardAccountDataSerializer as guardHeaderSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/accounts/candyGuard.js';
import { mplCandyMachine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID,
  CANDY_MACHINE_HIDDEN_SECTION, findCandyGuardPda, findCandyMachineAuthorityPda,
  getCandyMachineSize, getCandyMachineAccountDataSerializer, getCandyGuardDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { policy } from '../prepare.mjs';

const ERROR = 'EXPECTED_ACCOUNT_STATE_MISMATCH';
const fail = () => { throw Object.assign(Error(ERROR), { code: ERROR }); };
const requireThat = value => { if (!value) fail(); };
const equalBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const N = policy.supply - 1;
const name = index => policy.hiddenName.replace('{index:04d}', String(index).padStart(4, '0'));
const uri = index => `${policy.website}/metadata/hidden/${String(index).padStart(4, '0')}.json`;
const SETTINGS = { prefixName: '', nameLength: Buffer.byteLength(name(N)), prefixUri: '', uriLength: Buffer.byteLength(uri(N)), isSequential: false };
const MACHINE_SIZE = getCandyMachineSize(N, SETTINGS);
const OWNER = policy.owner;
const rpcDisabled = () => { throw Error('OFFLINE_ACCOUNT_VERIFIER'); };
const umi = createUmi('http://127.0.0.1:1', { fetch: rpcDisabled }).use(mplCandyMachine());
const programs = umi.programs;
// Program identities are cluster-independent local constants. Avoid the
// repository's default rpc.getCluster metadata accessor while resolving them.
umi.programs = { ...programs, get: identifier => programs.get(identifier, '*'),
  getPublicKey: (identifier, fallback) => programs.getPublicKey(identifier, fallback, '*'),
  has: identifier => programs.has(identifier, '*'), all: () => programs.all('*') };
const guardProgram = umi.programs.get('mplCoreCandyGuard');
umi.rpc = new Proxy({}, { get: () => rpcDisabled });
umi.http = new Proxy({}, { get: () => rpcDisabled });

function address(value) {
  requireThat(typeof value === 'string' && new PublicKey(value).toBase58() === value);
  return value;
}
function exact(value, fields) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), fields.split(' ').sort());
}
function classify(expected) {
  requireThat(expected && typeof expected === 'object' && !Array.isArray(expected));
  if (Object.hasOwn(expected, 'royaltyBasisPoints')) {
    exact(expected, 'collection updateAuthority name uri royaltyBasisPoints royaltyRecipient'
      + (Object.hasOwn(expected, 'machine') ? ' machine' : '')
      + (Object.hasOwn(expected, 'reservedAssetCreated') ? ' reservedAssetCreated' : ''));
    address(expected.collection); if (expected.machine !== undefined) address(expected.machine);
    if (Object.hasOwn(expected, 'reservedAssetCreated')) requireThat(expected.reservedAssetCreated === true);
    requireThat(expected.updateAuthority === OWNER && expected.royaltyRecipient === OWNER && expected.royaltyBasisPoints === policy.royaltyPercent * 100);
    requireThat(expected.name === policy.collectionName && expected.uri === `${policy.website}/metadata/collection.json`);
    return 'collection';
  }
  if (Object.hasOwn(expected, 'asset')) {
    exact(expected, 'asset index collection owner name uri');
    address(expected.asset); address(expected.collection);
    requireThat(expected.index === 0 && expected.owner === OWNER && expected.name === name(0) && expected.uri === uri(0));
    return 'reserve';
  }
  if (Object.hasOwn(expected, 'guard')) {
    exact(expected, 'machine guard collection authority guardAuthority mintAuthority itemsAvailable itemsLoaded machineSpace machineRentLamports configLineSettings addressGate payment salesOpen');
    address(expected.machine); address(expected.guard); address(expected.collection);
    requireThat(expected.authority === OWNER && expected.guardAuthority === OWNER && expected.addressGate === OWNER && expected.salesOpen === false);
    requireThat(expected.guard === findCandyGuardPda(umi, { base: expected.machine })[0] && expected.mintAuthority === expected.guard);
    requireThat(expected.itemsAvailable === N && Number.isSafeInteger(expected.itemsLoaded) && expected.itemsLoaded >= 0 && expected.itemsLoaded <= N && expected.machineSpace === MACHINE_SIZE);
    requireThat(typeof expected.machineRentLamports === 'string' && /^[1-9][0-9]*$/.test(expected.machineRentLamports) && BigInt(expected.machineRentLamports) <= (1n << 64n) - 1n);
    assert.deepEqual(expected.configLineSettings, SETTINGS);
    assert.deepEqual(expected.payment, { lamports: String(policy.priceSol * 1e9), destination: OWNER });
    return 'machine';
  }
  exact(expected, 'machine authority startingIndex count configLines');
  address(expected.machine); requireThat(expected.authority === OWNER);
  requireThat(Number.isSafeInteger(expected.startingIndex) && expected.startingIndex >= 0 && Number.isSafeInteger(expected.count) && expected.count > 0 && expected.startingIndex + expected.count <= N);
  requireThat(Array.isArray(expected.configLines) && expected.configLines.length === expected.count);
  expected.configLines.forEach((line, index) => assert.deepEqual(line, { name: name(expected.startingIndex + index + 1), uri: uri(expected.startingIndex + index + 1) }));
  return 'insert';
}

export function expectedAccountAddresses(expected) {
  try {
    const kind = classify(expected);
    return kind === 'collection' ? [expected.collection] : kind === 'reserve' ? [expected.asset]
      : kind === 'machine' ? [expected.machine, expected.guard] : [expected.machine];
  } catch { fail(); }
}

function rawAccount(value, program, maxBytes) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && value.owner === program && value.executable === false);
  requireThat(Number.isSafeInteger(value.lamports) && value.lamports > 0);
  requireThat(Array.isArray(value.data) && value.data.length === 2 && value.data[1] === 'base64' && typeof value.data[0] === 'string');
  requireThat(value.data[0].length > 0 && value.data[0].length <= Math.ceil(maxBytes / 3) * 4);
  const bytes = Buffer.from(value.data[0], 'base64');
  requireThat(bytes.length <= maxBytes && bytes.toString('base64') === value.data[0]);
  if (value.space !== undefined) requireThat(value.space === bytes.length);
  return bytes;
}
function canonicalPrefix(serializer, bytes, offset = 0) {
  const [value, end] = serializer.deserialize(bytes, offset);
  requireThat(Number.isSafeInteger(end) && end >= offset && end <= bytes.length);
  requireThat(equalBytes(serializer.serialize(value), bytes.subarray(offset, end)));
  return [value, end];
}

function verifyPlugins(bytes, baseEnd, expectedPlugins) {
  if (bytes.length === baseEnd) { requireThat(expectedPlugins.size === 0); return; }
  const [header, headerEnd] = canonicalPrefix(getPluginHeaderV1AccountDataSerializer(), bytes, baseEnd);
  requireThat(header.key === Key.PluginHeaderV1);
  const registryOffset = Number(header.pluginRegistryOffset);
  requireThat(Number.isSafeInteger(registryOffset) && registryOffset >= headerEnd && registryOffset + 9 <= bytes.length);
  requireThat(bytes[registryOffset] === Key.PluginRegistryV1);
  const count = bytes.readUInt32LE(registryOffset + 1);
  requireThat(count === expectedPlugins.size && count <= 2);
  const records = []; let cursor = registryOffset + 5;
  for (let index = 0; index < count; index++) {
    const [record, end] = canonicalPrefix(getRegistryRecordSerializer(), bytes, cursor);
    requireThat(expectedPlugins.has(record.pluginType));
    records.push(record); cursor = end;
  }
  requireThat(cursor + 4 === bytes.length && bytes.readUInt32LE(cursor) === 0); // No external plugin adapters.
  requireThat(new Set(records.map(record => record.pluginType)).size === records.length);
  records.sort((a, b) => Number(a.offset - b.offset));
  cursor = headerEnd;
  for (const record of records) {
    const expected = expectedPlugins.get(record.pluginType);
    assert.deepEqual(record.authority, expected.authority);
    requireThat(record.offset === BigInt(cursor));
    const encoded = getPluginSerializer().serialize(expected.plugin);
    requireThat(equalBytes(encoded, bytes.subarray(cursor, cursor + encoded.length)));
    cursor += encoded.length;
  }
  requireThat(cursor === registryOffset); // No overlaps, unexplained gaps or trailing plugin bytes.
}

function verifyCollection(expected, bytes, minted) {
  const [collection, end] = canonicalPrefix(collectionSerializer(), bytes);
  requireThat(collection.key === Key.CollectionV1 && collection.updateAuthority === expected.updateAuthority && collection.name === expected.name && collection.uri === expected.uri);
  const reservedCount = expected.reservedAssetCreated ? 1 : 0;
  if (minted === undefined) requireThat(collection.currentSize === reservedCount && collection.numMinted === reservedCount);
  else requireThat(collection.numMinted === minted && collection.currentSize <= minted);
  const plugins = new Map([[PluginType.Royalties, {
    authority: { __kind: 'UpdateAuthority' },
    plugin: { __kind: 'Royalties', fields: [{ basisPoints: expected.royaltyBasisPoints,
      creators: [{ address: expected.royaltyRecipient, percentage: 100 }], ruleSet: { __kind: 'None' } }] },
  }]]);
  if (expected.machine) {
    // Official CM initialization adds its authority PDA to additionalDelegates;
    // the plugin itself remains controlled by the Collection update authority.
    const delegate = findCandyMachineAuthorityPda(umi, { candyMachine: expected.machine })[0];
    plugins.set(PluginType.UpdateDelegate, { authority: { __kind: 'UpdateAuthority' },
      plugin: { __kind: 'UpdateDelegate', fields: [{ additionalDelegates: [delegate] }] } });
  }
  verifyPlugins(bytes, end, plugins);
}
function verifyReserve(expected, bytes) {
  const [asset, end] = canonicalPrefix(assetSerializer(), bytes);
  requireThat(asset.key === Key.AssetV1 && asset.owner === expected.owner && asset.name === expected.name && asset.uri === expected.uri);
  assert.deepEqual(asset.updateAuthority, { __kind: 'Collection', fields: [expected.collection] });
  verifyPlugins(bytes, end, new Map());
}

function machineState(bytes, minting = false) {
  requireThat(bytes.length === MACHINE_SIZE);
  // Bound the base decode to its reserved section before the SDK reads arrays.
  const [base, end] = canonicalPrefix(machineBaseSerializer(), bytes.subarray(0, CANDY_MACHINE_HIDDEN_SECTION));
  requireThat(base.authority === OWNER && (minting ? base.itemsRedeemed >= 0n && base.itemsRedeemed <= BigInt(N) : base.itemsRedeemed === 0n)
    && base.data.itemsAvailable === BigInt(N) && base.data.maxEditionSupply === 0n && base.data.isMutable === true);
  assert.deepEqual(base.data.configLineSettings, some(SETTINGS));
  assert.deepEqual(base.data.hiddenSettings, { __option: 'None' });
  requireThat(bytes.subarray(end, CANDY_MACHINE_HIDDEN_SECTION).every(byte => byte === 0));
  const loaded = bytes.readUInt32LE(CANDY_MACHINE_HIDDEN_SECTION);
  requireThat(minting ? loaded === N : loaded <= N);
  const lineSize = SETTINGS.nameLength + SETTINGS.uriLength;
  const linesOffset = CANDY_MACHINE_HIDDEN_SECTION + 4;
  const bitmapOffset = linesOffset + N * lineSize, bitmapBytes = Math.floor(N / 8) + 1;
  for (let index = 0; index < bitmapBytes * 8; index++) {
    const bit = (bytes[bitmapOffset + Math.floor(index / 8)] & (128 >> (index % 8))) !== 0;
    requireThat(bit === (index < loaded)); // This project's deployment loads a contiguous prefix.
  }
  const indicesOffset = bitmapOffset + bitmapBytes;
  const remaining = N - Number(base.itemsRedeemed), unused = new Set();
  for (let index = 0; index < N; index++) {
    const value = bytes.readUInt32LE(indicesOffset + index * 4);
    if (!minting) requireThat(value === (index < loaded ? index : 0));
    else {
      // Only this prefix is used by non-sequential minting. The consumed tail
      // is not an inventory source and need not be an identity permutation.
      if (index < remaining) { requireThat(value < N && !unused.has(value)); unused.add(value); }
    }
  }
  requireThat(bytes.subarray(indicesOffset + N * 4).every(byte => byte === 0));
  requireThat(bytes.subarray(linesOffset + loaded * lineSize, bitmapOffset).every(byte => byte === 0));
  const [decoded] = getCandyMachineAccountDataSerializer().deserialize(bytes);
  requireThat(decoded.itemsLoaded === loaded && decoded.items.length === loaded);
  return { ...base, itemsLoaded: loaded, linesOffset, lineSize };
}
function verifyMachine(expected, bytes, guardBytes) {
  const machine = machineState(bytes);
  requireThat(machine.collectionMint === expected.collection && machine.mintAuthority === expected.mintAuthority && machine.itemsLoaded === expected.itemsLoaded);
  verifyGuard(expected, guardBytes);
}
function verifyGuard(expected, guardBytes) {
  const [guardAddress, bump] = findCandyGuardPda(umi, { base: expected.machine });
  requireThat(guardAddress === expected.guard);
  // The 0.3.0 hooked account serializer hardcodes an unrelated discriminator.
  // Use the generated CandyGuard header (sha256("account:CandyGuard")[0:8]),
  // matching Rust #[account] CandyGuard and the captured Devnet binary.
  const header = guardHeaderSerializer().serialize({ base: expected.machine, bump, authority: expected.guardAuthority });
  const serializer = getCandyGuardDataSerializer(umi, guardProgram);
  const data = serializer.serialize({
    guards: { addressGate: some({ address: expected.addressGate }),
      solPayment: some({ lamports: lamports(BigInt(expected.payment.lamports)), destination: expected.payment.destination }) }, groups: [] });
  const expectedGuard = Buffer.concat([header, data]);
  // Compare the complete expected encoding BEFORE parsing variable guard arrays.
  requireThat(equalBytes(guardBytes, expectedGuard));
  // SDK reverseSerializer assumes Uint8Array.slice() copies. Buffer.slice()
  // aliases and its reversed guard bitmask would mutate our canonical bytes.
  const [guard, end] = serializer.deserialize(new Uint8Array(guardBytes.subarray(header.length)));
  requireThat(end === data.length && equalBytes(serializer.serialize(guard), data));
}

// Readiness of the completed, still-closed machine after zero or more mints.
// This does not relax deployment's zero-redemption/prefix invariants above.
// Public sale profiles and additional guards are intentionally unsupported.
export function verifyOrderAccounts(order, values) {
  try {
    const { machine, guard, collection, buyer } = order;
    [machine, guard, collection, buyer].forEach(address);
    requireThat(new Set([machine, guard, collection]).size === 3 && Array.isArray(values) && values.length === 3);
    const machineBytes = rawAccount(values[0], MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MACHINE_SIZE);
    const state = machineState(machineBytes, true);
    requireThat(state.collectionMint === collection && state.mintAuthority === guard);
    verifyGuard({ machine, guard, guardAuthority: OWNER, addressGate: OWNER,
      payment: { lamports: String(policy.priceSol * 1e9), destination: OWNER } },
    rawAccount(values[1], MPL_CORE_CANDY_GUARD_PROGRAM_ID, 65536));
    verifyCollection({ collection, machine, updateAuthority: OWNER, name: policy.collectionName,
      uri: `${policy.website}/metadata/collection.json`, royaltyBasisPoints: policy.royaltyPercent * 100,
      royaltyRecipient: OWNER }, rawAccount(values[2], MPL_CORE_PROGRAM_ID, 65536), Number(state.itemsRedeemed) + 1);
    for (let index = 0; index < N; index++) {
      const encoded = Buffer.alloc(state.lineSize);
      encoded.write(name(index + 1), 0, SETTINGS.nameLength, 'utf8');
      encoded.write(uri(index + 1), SETTINGS.nameLength, SETTINGS.uriLength, 'utf8');
      const at = state.linesOffset + index * state.lineSize;
      requireThat(equalBytes(encoded, machineBytes.subarray(at, at + state.lineSize)));
    }
    return { itemsRemaining: N - Number(state.itemsRedeemed), buyerAllowed: buyer === OWNER,
      guardPriceVerified: true, unitPriceLamports: String(policy.priceSol * 1e9), salesOpen: false };
  } catch { fail(); }
}
function verifyInsert(expected, bytes) {
  const machine = machineState(bytes);
  requireThat(machine.authority === expected.authority && machine.itemsLoaded >= expected.startingIndex + expected.count);
  for (const [offset, line] of expected.configLines.entries()) {
    const at = machine.linesOffset + (expected.startingIndex + offset) * machine.lineSize;
    const encoded = Buffer.alloc(machine.lineSize);
    encoded.write(line.name, 0, SETTINGS.nameLength, 'utf8');
    encoded.write(line.uri, SETTINGS.nameLength, SETTINGS.uriLength, 'utf8');
    requireThat(equalBytes(encoded, bytes.subarray(at, at + machine.lineSize)));
  }
}

export function verifyExpectedAccounts(expected, addresses, rpcAccountValues) {
  try {
    const kind = classify(expected);
    assert.deepEqual(addresses, expectedAccountAddresses(expected));
    requireThat(Array.isArray(rpcAccountValues) && rpcAccountValues.length === addresses.length);
    if (kind === 'collection') verifyCollection(expected, rawAccount(rpcAccountValues[0], MPL_CORE_PROGRAM_ID, 65536));
    else if (kind === 'reserve') verifyReserve(expected, rawAccount(rpcAccountValues[0], MPL_CORE_PROGRAM_ID, 65536));
    else {
      const machine = rawAccount(rpcAccountValues[0], MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MACHINE_SIZE);
      if (kind === 'machine') {
        requireThat(BigInt(rpcAccountValues[0].lamports) >= BigInt(expected.machineRentLamports));
        verifyMachine(expected, machine, rawAccount(rpcAccountValues[1], MPL_CORE_CANDY_GUARD_PROGRAM_ID, 65536));
      } else verifyInsert(expected, machine);
    }
    return true;
  } catch { fail(); }
}
