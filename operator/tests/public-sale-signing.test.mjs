// Synthetic offline addresses and commitment only. No wallet, owner secret,
// network request, signing or transaction submission is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { lamports, some } from '@metaplex-foundation/umi';
import { mplCandyMachine, findCandyGuardPda, MPL_CORE_CANDY_GUARD_PROGRAM_ID,
  getCandyGuardDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getUpdateCandyGuardInstructionDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/updateCandyGuard.js';
import policy from '../../metadata/policy.json' with { type: 'json' };
import { createPublicReleaseProfile } from '../public-sale/profile.mjs';
import { createGuardOpenSigningRequest, validateGuardOpenSigningRequest } from '../public-sale/signing.mjs';

const address = byte => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('OFFLINE_TEST_ONLY'); } }).use(mplCandyMachine());
const machine = address(71), collection = address(72);
const profile = createPublicReleaseProfile({ collection, machine,
  guard: findCandyGuardPda(umi, { base: machine })[0], hiddenCommitmentSha256: '1'.repeat(64) });
const deployment = revision => ({ deploymentId: 'offline-public-release',
  manifestSha256: '2'.repeat(64), revision, headHash: '3'.repeat(64) });
const context = revision => ({ profile, deployment: deployment(revision), privateLaunchMappingProofSha256: '4'.repeat(64) });
const input = revision => ({ releaseId: 'offline-opening', ...context(revision),
  blockhash: address(73), lastValidBlockHeight: 1000 });
const invalid = callback => assert.throws(callback, { code: 'PUBLIC_RELEASE_SIGNING' });

test('finalized37 recovery and acknowledged38 bind their actual revision to the identical guard-opening wire', t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('NO_NETWORK_ALLOWED'); });
  t.mock.method(VersionedTransaction.prototype, 'sign', () => { throw Error('NO_SIGNING_ALLOWED'); });
  const recovered = createGuardOpenSigningRequest(input(37));
  const acknowledged = createGuardOpenSigningRequest(input(38));
  assert.equal(recovered.deployment.revision, 37);
  assert.equal(acknowledged.deployment.revision, 38);
  assert.deepEqual(recovered.request, acknowledged.request);
  for (const [revision, request] of [[37, recovered], [38, acknowledged]]) {
    assert.deepEqual(validateGuardOpenSigningRequest(request, context(revision)), request);
    const transaction = VersionedTransaction.deserialize(Buffer.from(request.request.transactionBase64, 'base64'));
    assert.equal(transaction.version, 0);
    assert.equal(transaction.message.addressTableLookups.length, 0);
    assert.deepEqual(request.request.requiredSigners, [policy.owner]);
    assert.equal(transaction.message.header.numRequiredSignatures, 1);
    assert.equal(transaction.message.staticAccountKeys[0].toBase58(), policy.owner);
    assert.equal(transaction.signatures.length, 1);
    assert.ok(transaction.signatures[0].every(byte => byte === 0));
    const instructions = transaction.message.compiledInstructions;
    assert.equal(instructions.length, 2);
    const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
    assert.equal(keys[instructions[0].programIdIndex], ComputeBudgetProgram.programId.toBase58());
    assert.deepEqual([...instructions[0].data], [2, 64, 13, 3, 0]); // 200,000 units; no priority fee.
    assert.equal(keys[instructions[1].programIdIndex], MPL_CORE_CANDY_GUARD_PROGRAM_ID);
    assert.deepEqual([...instructions[1].accountKeyIndexes].map(index => keys[index]),
      [profile.guard, policy.owner, policy.owner, SystemProgram.programId.toBase58()]);
    const [update, end] = getUpdateCandyGuardInstructionDataSerializer().deserialize(instructions[1].data);
    assert.equal(end, instructions[1].data.length);
    const expected = getCandyGuardDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*')).serialize({
      guards: { solPayment: some({ lamports: lamports(BigInt(profile.unitPriceLamports)), destination: policy.owner }) }, groups: [],
    });
    assert.deepEqual(update.data, expected);
  }
});

test('public opening rejects unsupported36/39 and malformed deployment bindings', () => {
  for (const revision of [36, 39, 0, -1, 37.5, '37', null]) invalid(() => createGuardOpenSigningRequest(input(revision)));
  for (const changed of [
    { ...deployment(37), deploymentId: '../unexpected' },
    { ...deployment(37), manifestSha256: '0'.repeat(64) },
    { ...deployment(37), headHash: '0'.repeat(64) },
    { ...deployment(37), headHash: 'not-a-digest' },
    { ...deployment(37), extra: true },
  ]) invalid(() => createGuardOpenSigningRequest({ ...input(37), deployment: changed }));
  const missing = deployment(37); delete missing.headHash;
  invalid(() => createGuardOpenSigningRequest({ ...input(37), deployment: missing }));
});

test('a retained request cannot adopt a different completed revision, head or manifest', () => {
  for (const revision of [37, 38]) {
    const request = createGuardOpenSigningRequest(input(revision));
    for (const changed of [
      { ...deployment(revision), revision: revision === 37 ? 38 : 37 },
      { ...deployment(revision), headHash: '5'.repeat(64) },
      { ...deployment(revision), manifestSha256: '5'.repeat(64) },
    ]) invalid(() => validateGuardOpenSigningRequest(request, { ...context(revision), deployment: changed }));
    const altered = structuredClone(request); altered.deployment.headHash = '5'.repeat(64);
    invalid(() => validateGuardOpenSigningRequest(altered, context(revision)));
  }
});
