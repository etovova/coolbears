// Real SDK construction and independent web3 decoding, entirely offline.
// Public fixtures are arbitrary addresses, not generated keypairs/deployments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VersionedTransaction, PublicKey, SystemProgram } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { MPL_CORE_PROGRAM_ID, getCreateCollectionV2InstructionDataSerializer, getCreateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID,
  getInitializeCandyMachineInstructionDataSerializer,
  getCandyGuardDataSerializer, getAddConfigLinesInstructionDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCreateCandyGuardInstructionDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/createCandyGuard.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';

const address = byte => base58.deserialize(new Uint8Array(32).fill(byte))[0];
const input = { cluster: 'devnet', collection: address(31), reservedAsset: address(32),
  machine: address(33), blockhash: address(34), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' };
let cache;
const plan = () => cache ??= buildDeploymentPlan(input);
function decode(step) {
  const bytes = Buffer.from(step.transactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(bytes);
  const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
  const instructions = transaction.message.compiledInstructions.map(instruction => ({
    program: keys[instruction.programIdIndex], keys: [...instruction.accountKeyIndexes].map(index => keys[index]), data: instruction.data,
  }));
  return { bytes, transaction, keys, instructions };
}

test('complete deployment contains unsigned bounded templates with ordered dependencies and no launch claim', async () => {
  const result = await plan();
  assert.equal(result.mode, 'offline-unsigned-deployment');
  assert.equal(result.supply, 10000); assert.equal(result.machineItems, 9999); assert.equal(result.reservedItems, 1);
  assert.equal(result.steps.length, 1431); assert.equal(result.machineSpace, 871827);
  assert.equal(result.machineRentLamports, input.machineRentLamports);
  for (const flag of ['readyToSubmit', 'networkVerified', 'blockhashVerified', 'rentVerified', 'salesOpen']) assert.equal(result[flag], false);
  assert.equal(result.feeQuote, null);
  assert.deepEqual([result.networkRequests, result.signaturesCreated, result.transactionsSent], [0, 0, 0]);
  for (const [index, step] of result.steps.entries()) {
    const { bytes, transaction, keys } = decode(step);
    assert.equal(transaction.version, 0); assert.equal(bytes.length, step.serializedSize); assert.ok(bytes.length <= 1232);
    assert.equal(transaction.message.recentBlockhash, input.blockhash);
    assert.equal(step.lastValidBlockHeight, input.lastValidBlockHeight);
    assert.deepEqual(transaction.message.addressTableLookups, []);
    assert.deepEqual(keys.slice(0, transaction.message.header.numRequiredSignatures), step.requiredSigners);
    assert.equal(keys[0], policy.owner);
    assert.ok(transaction.signatures.every(signature => signature.every(byte => byte === 0)));
    assert.equal(step.messageSha256, createHash('sha256').update(transaction.message.serialize()).digest('hex'));
    assert.deepEqual(step.dependsOn, index ? [result.steps[index - 1].id] : []);
  }
  assert.equal(new Set(result.steps.map(step => step.id)).size, result.steps.length);
});

test('collection and reserve assign owner authority, royalties and canonical #0000 metadata', async () => {
  const result = await plan(); const [collection, reserve] = result.steps;
  assert.deepEqual(collection.requiredSigners, [policy.owner, input.collection]);
  const [collectionIx] = decode(collection).instructions;
  assert.equal(collectionIx.program, MPL_CORE_PROGRAM_ID);
  assert.deepEqual(collectionIx.keys.slice(0, 3), [input.collection, policy.owner, policy.owner]);
  const collectionData = getCreateCollectionV2InstructionDataSerializer().deserialize(collectionIx.data)[0];
  assert.equal(collectionData.name, policy.collectionName);
  assert.equal(collectionData.uri, `${policy.website}/metadata/collection.json`);
  const royalty = collectionData.plugins.value.find(({ plugin }) => plugin.__kind === 'Royalties').plugin;
  assert.equal(royalty.fields[0].basisPoints, 700);
  assert.deepEqual(royalty.fields[0].creators, [{ address: policy.owner, percentage: 100 }]);
  assert.deepEqual(reserve.requiredSigners, [policy.owner, input.reservedAsset]);
  const [reserveIx] = decode(reserve).instructions;
  assert.equal(reserveIx.program, MPL_CORE_PROGRAM_ID);
  assert.deepEqual(reserveIx.keys.slice(0, 5), [input.reservedAsset, input.collection, policy.owner, policy.owner, policy.owner]);
  const reserveData = getCreateV2InstructionDataSerializer().deserialize(reserveIx.data)[0];
  assert.equal(reserveData.name, policy.hiddenName.replace('{index:04d}', '0000'));
  assert.equal(reserveData.uri, `${policy.website}/metadata/hidden/0000.json`);
  assert.equal(reserve.expected.owner, policy.owner); assert.equal(reserve.expected.index, 0);
});

test('one machine transaction allocates full account, initializes owner authority, creates closed guard and wraps', async () => {
  const result = await plan(); const step = result.steps[2];
  assert.equal(step.kind, 'machine-create');
  assert.deepEqual(step.requiredSigners, [policy.owner, input.machine]);
  const [allocation, initialize, guard, wrap] = decode(step).instructions;
  assert.equal(allocation.program, SystemProgram.programId.toBase58());
  const allocationData = Buffer.from(allocation.data);
  assert.equal(allocationData.readUInt32LE(0), 0);
  assert.equal(allocationData.readBigUInt64LE(4), BigInt(input.machineRentLamports));
  assert.equal(allocationData.readBigUInt64LE(12), BigInt(result.machineSpace));
  assert.equal(new PublicKey(allocationData.subarray(20, 52)).toBase58(), MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  assert.deepEqual(allocation.keys, [policy.owner, input.machine]);
  assert.equal(initialize.program, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  assert.deepEqual([initialize.keys[0], ...initialize.keys.slice(2, 6)], [input.machine, policy.owner, policy.owner, input.collection, policy.owner]);
  const machineData = getInitializeCandyMachineInstructionDataSerializer().deserialize(initialize.data)[0];
  assert.equal(machineData.itemsAvailable, 9999n); assert.equal(machineData.isMutable, true);
  assert.equal(machineData.configLineSettings.value.isSequential, false);
  assert.equal(guard.program, MPL_CORE_CANDY_GUARD_PROGRAM_ID);
  assert.deepEqual(guard.keys.slice(0, 4), [result.roles.guard, input.machine, policy.owner, policy.owner]);
  const guardBytes = getCreateCandyGuardInstructionDataSerializer().deserialize(guard.data)[0].data;
  const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('NETWORK_DISABLED'); } }).use(mplCandyMachine());
  const guardData = getCandyGuardDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*')).deserialize(guardBytes)[0];
  assert.equal(guardData.guards.addressGate.value.address, policy.owner);
  assert.equal(guardData.guards.solPayment.value.destination, policy.owner);
  assert.equal(guardData.guards.solPayment.value.lamports.basisPoints, 500000000n);
  assert.deepEqual(guardData.groups, []);
  assert.equal(wrap.program, MPL_CORE_CANDY_GUARD_PROGRAM_ID);
  assert.deepEqual(wrap.keys, [result.roles.guard, policy.owner, input.machine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, policy.owner]);
  assert.equal(step.expected.mintAuthority, result.roles.guard); assert.equal(step.expected.salesOpen, false);
});

test('all insertion bytes cover canonical #0001–#9999 exactly once with contiguous chain indices', async () => {
  const result = await plan(); const insertions = result.steps.filter(step => step.kind === 'insert');
  assert.equal(insertions.length, 1428);
  let nextIndex = 0;
  for (const step of insertions) {
    assert.deepEqual(step.requiredSigners, [policy.owner]);
    assert.equal(step.expected.startingIndex, nextIndex);
    const linesInStep = [];
    for (const instruction of decode(step).instructions) {
      assert.equal(instruction.program, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
      assert.deepEqual(instruction.keys, [input.machine, policy.owner]);
      const data = getAddConfigLinesInstructionDataSerializer().deserialize(instruction.data)[0];
      assert.equal(data.index, nextIndex);
      for (const line of data.configLines) {
        const number = String(++nextIndex).padStart(4, '0');
        assert.deepEqual(line, { name: policy.hiddenName.replace('{index:04d}', number), uri: `${policy.website}/metadata/hidden/${number}.json` });
        linesInStep.push(line);
      }
    }
    assert.deepEqual(step.expected.configLines, linesInStep);
    assert.equal(step.expected.count, linesInStep.length);
  }
  assert.equal(nextIndex, 9999);
  assert.equal(insertions.at(-1).expected.count, 10, 'CLI packing merges the final 7-line and 3-line instructions');
});

test('network is never accessed and mainnet label makes no on-chain or rent assertion', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw Error('NETWORK_DISABLED'); };
  try {
    const result = await buildDeploymentPlan({ ...input, cluster: 'mainnet-beta' });
    assert.equal(calls, 0); assert.equal(result.cluster, 'mainnet-beta');
    assert.equal(result.networkVerified, false); assert.equal(result.rentVerified, false);
    assert.deepEqual(result.steps, (await plan()).steps);
  } finally { globalThis.fetch = previous; }
});

test('malformed, missing and ambiguous deployment inputs are rejected before building', async () => {
  await assert.rejects(buildDeploymentPlan());
  for (const changes of [
    { cluster: 'mainnet' }, { collection: '' }, { collection: input.machine }, { reservedAsset: policy.owner },
    { machine: input.reservedAsset }, { machine: null }, { blockhash: 'not-a-blockhash' },
    { lastValidBlockHeight: 0 }, { lastValidBlockHeight: 1.1 }, { lastValidBlockHeight: '100' },
    { machineRentLamports: 5000000000 }, { machineRentLamports: '0' }, { machineRentLamports: '-1' },
    { machineRentLamports: '01' }, { machineRentLamports: '1.1' }, { machineRentLamports: '1e9' },
    { machineRentLamports: '18446744073709551616' },
  ]) await assert.rejects(buildDeploymentPlan({ ...input, ...changes }));
});

test('full SDK plan projects into a durable fresh journal without keys or signing', async () => {
  const { createDeploymentJournal, readDeploymentJournal, nextDeploymentAction } = await import('../deployment/journal.mjs');
  const result = await plan(); const manifest = deploymentManifestFromPlan('full-offline-fixture', result);
  assert.deepEqual(Object.keys(manifest).sort(), ['cluster', 'id', 'owner', 'steps', 'version']);
  assert.equal(manifest.steps.length, result.steps.length);
  const directory = await mkdtemp(path.join(tmpdir(), 'coolbears-deployment-plan-'));
  try {
    const journal = await createDeploymentJournal(path.join(directory, 'journal'), manifest);
    assert.equal(journal.revision, 0); assert.equal(journal.steps.length, 1431);
    assert.deepEqual(nextDeploymentAction(journal), { type: 'prepare', stepId: 'collection-create' });
    assert.ok(journal.steps.every(step => step.attempts.length === 0));
    assert.deepEqual((await readDeploymentJournal(path.join(directory, 'journal'))).manifest, manifest);
    manifest.steps[0].expected.name = 'changed local projection';
    assert.equal(result.steps[0].expected.name, policy.collectionName, 'Manifest does not alias plan data');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
