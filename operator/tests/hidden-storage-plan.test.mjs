// Synthetic public fixtures exercise the official SDK offline. Their digest is
// not a commitment to the owner's collection and must never enable a launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicKey, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCandyMachine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
  getInitializeCandyMachineInstructionDataSerializer, getCandyGuardDataSerializer,
  getHiddenSettingsSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCreateCandyGuardInstructionDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/createCandyGuard.js';
import { policy, makePreparation, prepare } from '../prepare.mjs';
import { resolveStorageProfile, resolveHiddenIndexedMetadata, hiddenSettingsForSdk } from '../storage-mode.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { validateCanonicalDeploymentManifest } from '../deployment/intent.mjs';
import { getConfigLineSettings } from '../node_modules/@metaplex-foundation/cli/dist/lib/cm/cm-utils.js';

const address = byte => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const hash = createHash('sha256').update('SYNTHETIC TEST FIXTURE ONLY: ordered final content').digest('hex');
const options = { storageMode: 'hidden-settings', hiddenCommitmentSha256: hash };
const input = { cluster: 'devnet', collection: address(51), reservedAsset: address(52), machine: address(53),
  blockhash: address(54), lastValidBlockHeight: 1000, machineRentLamports: '5428800', ...options };
let cachedPlan;
const plan = () => cachedPlan ??= buildDeploymentPlan(input);

function instructions(step) {
  const tx = VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64'));
  const keys = tx.message.staticAccountKeys.map(key => key.toBase58());
  return { tx, instructions: tx.message.compiledInstructions.map(ix => ({
    program: keys[ix.programIdIndex], keys: [...ix.accountKeyIndexes].map(index => keys[index]), data: ix.data,
  })) };
}

test('explicit hidden profile has stable decimal SDK identity and a 652-byte account', () => {
  const profile = resolveStorageProfile(policy, options);
  assert.deepEqual(profile, { storageMode: 'hidden-settings', configLineSettings: null,
    hiddenSettings: { name: 'CoolBears #$ID+1$',
      uri: `${policy.website}/metadata/hidden-indexed/$ID+1$.json`, hash }, machineSpace: 652 });
  for (const index of [1, 9, 10, 999, 1000, 9999]) {
    assert.deepEqual(resolveHiddenIndexedMetadata(policy, index), {
      name: `CoolBears #${index}`, uri: `${policy.website}/metadata/hidden-indexed/${index}.json`,
    });
  }
  for (const index of [0, -1, 10000, 1.5, '1', null]) {
    assert.throws(() => resolveHiddenIndexedMetadata(policy, index), /INVALID_HIDDEN_METADATA_INDEX/);
  }
  assert.equal(Buffer.from(hiddenSettingsForSdk(profile.hiddenSettings).hash).toString('hex'), hash);
  assert.equal(hiddenSettingsForSdk(null), null);
});

test('default profile and preparation retain every legacy config line and reserve', () => {
  const profile = resolveStorageProfile(policy);
  assert.equal(profile.storageMode, 'config-lines'); assert.equal(profile.machineSpace, 871827);
  assert.equal(profile.hiddenSettings, null);
  const legacy = makePreparation();
  assert.deepEqual(legacy.cmConfig.config.configLineSettings, profile.configLineSettings);
  assert.equal(Object.keys(legacy.assetCache.assetItems).length, 9999);
  assert.equal(legacy.cmConfig.config.hiddenSettings, undefined);
  assert.equal(legacy.releasePlan.storageMode, undefined);
  const small = resolveStorageProfile({ ...policy, supply: 4 });
  assert.deepEqual(small.configLineSettings, profile.configLineSettings);
  const hidden = makePreparation({ collection: input.collection, ...options });
  assert.deepEqual(hidden.releasePlan.reservedAsset, { ...legacy.releasePlan.reservedAsset, collection: input.collection });
  assert.equal(hidden.documents.length, legacy.documents.length);
  assert.equal(createHash('sha256').update(JSON.stringify(hidden.documents)).digest('hex'),
    createHash('sha256').update(JSON.stringify(legacy.documents)).digest('hex'));
});

test('hidden mode requires a declared digest and never silently downgrades or accepts a placeholder', () => {
  for (const hiddenCommitmentSha256 of [undefined, '', null, '0'.repeat(64), 'f'.repeat(63), 'F'.repeat(64), 'g'.repeat(64), new Uint8Array(32)]) {
    assert.throws(() => makePreparation({ storageMode: 'hidden-settings', hiddenCommitmentSha256 }), /INVALID_HIDDEN_COMMITMENT_SHA256/);
  }
  for (const storageMode of ['hidden', '', null, {}, 'unknown']) {
    assert.throws(() => makePreparation({ storageMode, hiddenCommitmentSha256: hash }), /INVALID_STORAGE_MODE/);
  }
  assert.throws(() => makePreparation({ hiddenCommitmentSha256: hash }), /HIDDEN_COMMITMENT_REQUIRES_HIDDEN_SETTINGS/);
  assert.throws(() => makePreparation({ ...options, metadataBase: 'https://example.com/' }), /approved indexed/);
});

test('hidden preparation keeps sales closed and exposes only the declared commitment', () => {
  const result = makePreparation({ collection: input.collection, ...options });
  assert.equal(result.cmConfig.config.itemsAvailable, 9999);
  assert.equal(result.cmConfig.config.isSequential, true);
  assert.equal(result.cmConfig.config.configLineSettings, null);
  assert.deepEqual(result.assetCache, { assetItems: {} });
  assert.equal(result.releasePlan.hiddenCommitmentSha256, hash);
  assert.equal(result.releasePlan.commitmentStatus, 'declared-unverified-private-mapping');
  assert.equal(result.releasePlan.privateRevealMappingVerified, false);
  assert.equal(result.releasePlan.configLineInsertions, 0);
  assert.equal(result.releasePlan.salesOpen, false); assert.equal(result.releasePlan.transactionsSent, 0);
  assert.deepEqual(result.releasePlan.payment, { lamports: '200000000', destination: policy.owner });
  assert.equal(result.plugins.royalties.basisPoints, 700);
  for (const document of result.documents) {
    assert.equal(document.description, policy.hiddenDescription);
    assert.equal(document.image, `${policy.website}/assets/collection/gif.gif`);
    for (const key of ['attributes', 'rank', 'rarity', 'rarity_score']) assert.equal(document[key], undefined);
  }
});

test('persisted CLI JSON carries all 32 commitment bytes through the official CLI parser and SDK serializer', () => {
  const json = JSON.parse(JSON.stringify(makePreparation({ collection: input.collection, ...options }).cmConfig));
  const parsed = getConfigLineSettings(json);
  assert.equal(parsed.configLineSettings, undefined);
  assert.equal(Array.isArray(parsed.hiddenSettings.hash), true);
  assert.equal(parsed.hiddenSettings.hash.length, 32);
  const serializer = getHiddenSettingsSerializer();
  const decoded = serializer.deserialize(serializer.serialize(parsed.hiddenSettings))[0];
  assert.equal(Buffer.from(decoded.hash).toString('hex'), hash);
  assert.equal(decoded.name, 'CoolBears #$ID+1$');
  assert.equal(decoded.uri, `${policy.website}/metadata/hidden-indexed/$ID+1$.json`);
});

test('official SDK hidden deployment has only three bounded unsigned creation transactions', async () => {
  const previousFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = () => { network++; throw Error('NETWORK_DISABLED'); };
  try {
    const result = await plan();
    assert.equal(result.machineSpace, 652); assert.equal(result.machineItems, 9999);
    assert.deepEqual(result.steps.map(step => step.id), ['collection-create', 'reserve-create', 'machine-create']);
    assert.deepEqual(result.steps.map(step => step.serializedSize), [424, 442, 824]);
    assert.equal(result.privateRevealMappingVerified, false);
    for (const key of ['readyToSubmit', 'networkVerified', 'blockhashVerified', 'rentVerified', 'salesOpen']) assert.equal(result[key], false);
    assert.deepEqual([result.networkRequests, result.signaturesCreated, result.transactionsSent], [0, 0, 0]);
    for (const [index, step] of result.steps.entries()) {
      const { tx } = instructions(step);
      assert.ok(step.serializedSize <= 1232);
      assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)));
      assert.equal(step.requiredSigners[0], policy.owner);
      assert.deepEqual(step.dependsOn, index ? [result.steps[index - 1].id] : []);
      assert.equal(step.messageSha256, createHash('sha256').update(tx.message.serialize()).digest('hex'));
    }
    assert.equal(network, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('decoded SDK bytes contain the trusted 32-byte commitment, no config lines and the owner price guard', async () => {
  const result = await plan();
  const [allocation, initialize, guard, wrap] = instructions(result.steps[2]).instructions;
  assert.equal(allocation.program, SystemProgram.programId.toBase58());
  assert.equal(Buffer.from(allocation.data).readBigUInt64LE(12), 652n);
  assert.equal(Buffer.from(allocation.data).readBigUInt64LE(4), BigInt(input.machineRentLamports));
  assert.equal(initialize.program, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  const data = getInitializeCandyMachineInstructionDataSerializer().deserialize(initialize.data)[0];
  assert.equal(data.itemsAvailable, 9999n); assert.equal(data.isMutable, true);
  assert.deepEqual(data.configLineSettings, { __option: 'None' });
  assert.equal(data.hiddenSettings.value.name, 'CoolBears #$ID+1$');
  assert.equal(data.hiddenSettings.value.uri, `${policy.website}/metadata/hidden-indexed/$ID+1$.json`);
  assert.equal(Buffer.from(data.hiddenSettings.value.hash).toString('hex'), hash);
  const umi = createUmi('http://127.0.0.1:1', { fetch() { throw Error('NETWORK_DISABLED'); } }).use(mplCandyMachine());
  const guardBytes = getCreateCandyGuardInstructionDataSerializer().deserialize(guard.data)[0].data;
  const guardData = getCandyGuardDataSerializer(umi, umi.programs.get('mplCoreCandyGuard', '*')).deserialize(guardBytes)[0];
  assert.equal(guardData.guards.addressGate.value.address, policy.owner);
  assert.equal(guardData.guards.solPayment.value.destination, policy.owner);
  assert.equal(guardData.guards.solPayment.value.lamports.basisPoints, 200000000n);
  assert.deepEqual(guardData.groups, []);
  assert.equal(wrap.keys[0], result.roles.guard);
  assert.equal(result.steps[2].expected.configLineSettings, null);
});

test('canonical validation rebuilds declared hidden intent and optionally binds an externally trusted digest', async () => {
  const manifest = deploymentManifestFromPlan('synthetic-hidden-intent', await plan());
  assert.deepEqual(Object.keys(manifest).sort(), ['cluster', 'id', 'owner', 'steps', 'version']);
  for (const trust of [{}, { trustedHiddenCommitmentSha256: hash }]) {
    const validated = await validateCanonicalDeploymentManifest(manifest, trust);
    assert.equal(validated.steps.length, 3); assert.equal(validated.privateRevealMappingVerified, false);
    assert.deepEqual(deploymentManifestFromPlan(manifest.id, validated), manifest);
  }
  const otherHash = createHash('sha256').update('other synthetic fixture').digest('hex');
  await assert.rejects(validateCanonicalDeploymentManifest(manifest, { trustedHiddenCommitmentSha256: otherHash }), { code: 'DEPLOYMENT_INTENT_INVALID' });
  for (const change of [
    candidate => { delete candidate.steps[2].expected.storageMode; },
    candidate => { candidate.steps[2].expected.storageMode = 'hidden'; },
    candidate => { candidate.steps[2].expected.hiddenSettings.hash = otherHash; },
    candidate => { candidate.steps[2].expected.hiddenSettings.uri = `${policy.website}/metadata/hidden/$ID+1$.json`; },
    candidate => { candidate.steps[2].expected.configLineSettings = resolveStorageProfile(policy).configLineSettings; },
    candidate => { candidate.steps[2].expected.machineSpace = 871827; },
    candidate => { candidate.steps[2].expected.payment.lamports = '1'; },
    candidate => { candidate.steps[2].expected.privateRevealMappingVerified = true; },
    candidate => { candidate.steps.push(structuredClone(candidate.steps[2])); },
    candidate => { candidate.steps.pop(); },
  ]) {
    const changed = structuredClone(manifest); change(changed);
    await assert.rejects(validateCanonicalDeploymentManifest(changed), { code: 'DEPLOYMENT_INTENT_INVALID' });
  }
});

test('hidden disk preparation adds decimal public routes without overwriting the original padded routes', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'coolbears-hidden-preparation-'));
  try {
    const destination = path.join(temp, 'candidate');
    await prepare(destination, options);
    const first = JSON.parse(await readFile(path.join(destination, 'hidden-indexed/1.json'), 'utf8'));
    assert.equal(first.name, 'CoolBears #0001 — Hidden Bear');
    assert.deepEqual(first, JSON.parse(await readFile(path.join(destination, 'hidden/0001.json'), 'utf8')));
    assert.equal((await readdir(path.join(destination, 'hidden-indexed'))).length, 9999);
    assert.equal((await readdir(path.join(destination, 'hidden'))).length, 10000);
    await assert.rejects(readFile(path.join(destination, 'hidden-indexed/0.json')), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'asset-cache.json'), 'utf8')), { assetItems: {} });
    const saved = JSON.parse(await readFile(path.join(destination, 'preparation.json'), 'utf8'));
    assert.equal(saved.privateRevealMappingVerified, false);
    assert.equal(saved.hiddenCommitmentSha256, hash);
    await assert.rejects(prepare(destination, options), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'hidden-indexed/1.json'), 'utf8')), first);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
