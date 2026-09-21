import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePreparation, prepare, policy } from '../prepare.mjs';
import jsonGuardParser from '../node_modules/@metaplex-foundation/cli/dist/lib/cm/jsonGuardParser.js';
import { getConfigLineSettings, validateCmConfig } from '../node_modules/@metaplex-foundation/cli/dist/lib/cm/cm-utils.js';
import { validateCacheUploads, ValidateCacheUploadsOptions } from '../node_modules/@metaplex-foundation/cli/dist/lib/cm/validateCacheUploads.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, generateSigner, signerIdentity, lamports } from '@metaplex-foundation/umi';
import { createCollection, getCreateCollectionV2InstructionDataSerializer, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { create, mplCandyMachine, getInitializeCandyMachineInstructionDataSerializer, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { PROGRAMS } from '../preflight.mjs';

test('all metadata preserve the approved description and original GIF; no reveal data', () => {
  const p = makePreparation();
  assert.equal(p.documents.length, 10000);
  assert.equal(new Set(p.documents.map(x => x.name)).size, 10000);
  for (const item of p.documents) {
    assert.equal(item.description, policy.hiddenDescription);
    assert.equal(item.image, `${policy.website}/assets/collection/gif.gif`);
    assert.equal(item.animation_url, item.image);
    assert.deepEqual(Object.keys(item).sort(), ['animation_url','description','external_url','image','name','properties']);
    assert.ok(Buffer.byteLength(item.name) <= 32);
  }
});

test('CLI cache contains exactly the non-reserved items with matching names and URIs', async () => {
  const p = makePreparation();
  const items = Object.values(p.assetCache.assetItems);
  assert.equal(items.length, 9999);
  assert.equal(new Set(items.map(x => x.jsonUri)).size, 9999);
  items.forEach((item, index) => {
    assert.equal(item.name, p.documents[index + 1].name);
    assert.ok(item.jsonUri.endsWith(`/${String(index + 1).padStart(4, '0')}.json`));
    assert.equal(item.loaded, false);
  });
  await validateCacheUploads(p.assetCache, ValidateCacheUploadsOptions.STORAGE);
  await assert.rejects(validateCacheUploads(p.assetCache, ValidateCacheUploadsOptions.ONCHAIN));
});

test('the official CLI parser preserves the owner gate, full price, royalty settings and no wallet mint limit', () => {
  const p = makePreparation({ collection: policy.owner });
  validateCmConfig(p.cmConfig);
  const parsed = jsonGuardParser(p.cmConfig);
  assert.equal(parsed.guards.addressGate.value.address, policy.owner);
  assert.equal(parsed.guards.solPayment.value.lamports.basisPoints, 500000000n);
  assert.equal(parsed.guards.solPayment.value.destination, policy.owner);
  assert.equal(parsed.guards.mintLimit, undefined);
  assert.deepEqual(parsed.groups, []);
  assert.equal(p.plugins.royalties.basisPoints, 700);
  assert.equal(p.plugins.royalties.creators[0].percentage, 100);
});

test('unconfigured or already-created projects fail CLI creation validation', () => {
  const p = makePreparation();
  assert.throws(() => validateCmConfig(p.cmConfig), /No collection/);
  p.cmConfig.config.collection = policy.owner;
  p.cmConfig.candyMachineId = policy.owner;
  assert.throws(() => validateCmConfig(p.cmConfig), /already exists/);
});

test('metadata base rejects HTTP, credentials and overlong URIs', () => {
  for (const metadataBase of ['http://example.com/', 'https://name:password@example.com/', 'https://example.com/?secret=abc', 'https://example.com/' + 'a'.repeat(200) + '/']) {
    assert.throws(() => makePreparation({ metadataBase }));
  }
  assert.throws(() => makePreparation({ collection: 'not-a-public-key' }));
});

test('real SDK serializes the CLI configuration and royalty instructions without network calls', async () => {
  const umi = createUmi('http://127.0.0.1:1').use(mplCandyMachine());
  const signer = createSignerFromKeypair(umi, umi.eddsa.generateKeypair());
  umi.use(signerIdentity(signer));
  let rentCalls = 0;
  umi.rpc.getRent = async () => { rentCalls++; return lamports(10000000); };
  const collection = generateSigner(umi);
  const p = makePreparation({ collection: collection.publicKey });
  const parsed = jsonGuardParser(p.cmConfig);
  const royaltyBuilder = createCollection(umi, { collection, name: policy.collectionName, uri: `${policy.website}/metadata/collection.json`, plugins: Object.values(p.plugins) });
  const royaltyData = getCreateCollectionV2InstructionDataSerializer().deserialize(royaltyBuilder.getInstructions()[0].data)[0];
  assert.equal(royaltyData.name, policy.collectionName);
  assert.ok(royaltyBuilder.fitsInOneTransaction(umi));
  const builder = await create(umi, {
    ...p.cmConfig.config, candyMachine: generateSigner(umi), collection: collection.publicKey,
    collectionUpdateAuthority: signer, guards: parsed.guards, groups: parsed.groups,
    ...getConfigLineSettings(p.cmConfig),
  });
  assert.equal(rentCalls, 1);
  const initialize = builder.getInstructions().find(ix => ix.programId === MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  const decoded = getInitializeCandyMachineInstructionDataSerializer().deserialize(initialize.data)[0];
  assert.equal(decoded.itemsAvailable, 9999n);
  assert.equal(decoded.isMutable, true);
  assert.equal(decoded.configLineSettings.value.isSequential, false);
  assert.deepEqual(PROGRAMS, [MPL_CORE_PROGRAM_ID, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID]);
});

test('disk preparation creates the full set and refuses to overwrite an existing project', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'coolbears-new-preparation-'));
  try {
    const destination = path.join(temp, 'project');
    const result = await prepare(destination);
    assert.equal(result.documents, 10000);
    const first = JSON.parse(await readFile(path.join(destination, 'hidden/0000.json')));
    const last = JSON.parse(await readFile(path.join(destination, 'hidden/9999.json')));
    assert.equal(first.name, 'CoolBears #0000 — Hidden Bear');
    assert.equal(last.name, 'CoolBears #9999 — Hidden Bear');
    await assert.rejects(prepare(destination), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'hidden/0000.json'))), first);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
