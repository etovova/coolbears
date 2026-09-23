// Read public executable bytes and sysvars. This transport cannot submit a tx.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { rpcContext, requireDeploymentCheck as need } from './read.mjs';
import { assertCluster, GENESIS_HASHES } from './rpc.mjs';

export const ISOLATED_PROGRAMS = Object.freeze([MPL_CORE_PROGRAM_ID,
  MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID]);
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

function accountBytes(account, owner, executable, maxBytes) {
  need(account?.owner === owner && account.executable === executable
    && Number.isSafeInteger(account.lamports) && account.lamports > 0
    && Array.isArray(account.data) && account.data.length === 2 && account.data[1] === 'base64'
    && typeof account.data[0] === 'string' && account.data[0].length <= Math.ceil(maxBytes / 3) * 4,
  'INVALID_ISOLATED_SOURCE_ACCOUNT');
  const bytes = Buffer.from(account.data[0], 'base64');
  need(bytes.length <= maxBytes && bytes.toString('base64') === account.data[0]
    && (account.space === undefined || account.space === bytes.length), 'INVALID_ISOLATED_SOURCE_ENCODING');
  return bytes;
}

function programDataAddress(account) {
  const bytes = accountBytes(account, UPGRADEABLE_LOADER, true, 36);
  need(bytes.length === 36 && bytes.readUInt32LE(0) === 2, 'INVALID_UPGRADEABLE_PROGRAM');
  return new PublicKey(bytes.subarray(4)).toBase58();
}

// Source: solana-loader-v3-interface UpgradeableLoaderState. Program = 36 B;
// ProgramData metadata = 45 B even with no upgrade authority, then ELF bytes.
export function decodeIsolatedSnapshot(snapshot) {
  need(snapshot?.version === 1 && snapshot.genesisHash === GENESIS_HASHES.devnet
    && Array.isArray(snapshot.addresses) && snapshot.addresses.length === 8,
  'INVALID_ISOLATED_SNAPSHOT');
  const slot = rpcContext(snapshot.accounts);
  need(Array.isArray(snapshot.accounts.value) && snapshot.accounts.value.length === 8,
    'INVALID_ISOLATED_ACCOUNT_LIST');
  const values = snapshot.accounts.value;
  const dataAddresses = values.slice(0, 3).map(programDataAddress);
  const expected = [...ISOLATED_PROGRAMS, ...dataAddresses, RENT_SYSVAR, CLOCK_SYSVAR];
  need(expected.every((key, i) => key === snapshot.addresses[i])
    && new Set(expected).size === 8, 'ISOLATED_PROGRAM_BINDING_MISMATCH');
  const programs = ISOLATED_PROGRAMS.map((address, i) => {
    const data = accountBytes(values[i + 3], UPGRADEABLE_LOADER, false, 6 * 1024 * 1024);
    need(data.length > 49 && data.readUInt32LE(0) === 3 && [0, 1].includes(data[12])
      && data.readBigUInt64LE(4) <= BigInt(slot), 'INVALID_PROGRAM_DATA');
    const elf = data.subarray(45);
    need(elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'INVALID_PROGRAM_ELF');
    return { address, programDataAddress: dataAddresses[i], deploymentSlot: data.readBigUInt64LE(4).toString(),
      upgradeAuthority: data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null,
      programDataSha256: bytesHash(data), elfSha256: bytesHash(elf), elfBytes: elf.length, elf };
  });
  const rentBytes = accountBytes(values[6], SYSVAR_OWNER, false, 17);
  need(rentBytes.length === 17, 'INVALID_RENT_SYSVAR');
  const rent = { lamportsPerByteYear: rentBytes.readBigUInt64LE(0).toString(),
    exemptionThreshold: rentBytes.readDoubleLE(8), burnPercent: rentBytes[16] };
  need(BigInt(rent.lamportsPerByteYear) > 0n && Number.isFinite(rent.exemptionThreshold)
    && rent.exemptionThreshold > 0 && rent.exemptionThreshold <= 100 && rent.burnPercent <= 100,
  'INVALID_RENT_SYSVAR');
  const clockBytes = accountBytes(values[7], SYSVAR_OWNER, false, 40);
  need(clockBytes.length === 40, 'INVALID_CLOCK_SYSVAR');
  const clock = { slot: clockBytes.readBigUInt64LE(0).toString(),
    epochStartTimestamp: clockBytes.readBigInt64LE(8).toString(), epoch: clockBytes.readBigUInt64LE(16).toString(),
    leaderScheduleEpoch: clockBytes.readBigUInt64LE(24).toString(), unixTimestamp: clockBytes.readBigInt64LE(32).toString() };
  need(BigInt(clock.slot) === BigInt(slot), 'ISOLATED_CLOCK_SLOT_MISMATCH');
  return { slot, programs, rent, clock, rentSha256: bytesHash(rentBytes), clockSha256: bytesHash(clockBytes) };
}

export async function captureIsolatedSnapshot(rpc) {
  const genesisHash = await assertCluster(rpc, 'devnet');
  const discovery = await rpc.call('getMultipleAccounts', [ISOLATED_PROGRAMS,
    { commitment: 'finalized', encoding: 'base64' }]);
  const minimum = rpcContext(discovery);
  need(Array.isArray(discovery.value) && discovery.value.length === 3, 'INVALID_ISOLATED_PROGRAM_LIST');
  const addresses = [...ISOLATED_PROGRAMS, ...discovery.value.map(programDataAddress), RENT_SYSVAR, CLOCK_SYSVAR];
  // All binaries and sysvars from ONE finalized bank; discovery is not evidence.
  const accounts = await rpc.call('getMultipleAccounts', [addresses,
    { commitment: 'finalized', encoding: 'base64', minContextSlot: minimum }]);
  rpcContext(accounts, minimum);
  const snapshot = { version: 1, kind: 'public-devnet-program-snapshot', genesisHash,
    capturedAt: new Date().toISOString(), addresses, accounts };
  decodeIsolatedSnapshot(snapshot);
  return snapshot;
}
