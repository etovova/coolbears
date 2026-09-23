import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, policy } from '../prepare.mjs';
import { verifyPreparation } from '../verify-preparation.mjs';

const otherAddress = '11111111111111111111111111111111';

describe('saved offline preparation integrity', { concurrency: false }, () => {
  let temp, directory, originalFetch, fetchCalls = 0;

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw Error('Network access is forbidden during offline preparation tests');
    };
    temp = await mkdtemp(path.join(os.tmpdir(), 'coolbears-verify-preparation-'));
    directory = path.join(temp, 'fresh-project');
    await prepare(directory);
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (temp) await rm(temp, { recursive: true, force: true });
    assert.equal(fetchCalls, 0, 'Neither preparation nor verification may attempt a network request');
  });

  // Keep one complete 10,000-file fixture. Every corruption restores the exact
  // original bytes even if its assertion fails, so later cases stay independent.
  async function withJsonChange(relative, change, check) {
    const filename = path.join(directory, relative);
    const original = await readFile(filename, 'utf8');
    const value = JSON.parse(original);
    try {
      change(value);
      await writeFile(filename, JSON.stringify(value) + '\n');
      await check();
    } finally {
      await writeFile(filename, original);
    }
  }

  const rejectChange = (relative, change) => withJsonChange(relative, change, () =>
    assert.rejects(verifyPreparation(directory), error =>
      error.message === `Preparation mismatch: ${relative}`));

  test('a fresh full package verifies without network and does not claim deployment readiness', async () => {
    const report = await verifyPreparation(directory);
    assert.equal(report.status, 'offline-preparation-verified');
    assert.equal(report.metadataDocuments, 10000);
    assert.equal(report.machineItems, 9999);
    assert.equal(report.reservedIndex, 0);
    assert.equal(report.reservedOwner, policy.owner);
    assert.equal(report.reservedAssetCreated, false);
    assert.equal(report.priceLamports, '200000000');
    assert.equal(report.royaltyBasisPoints, 700);
    assert.equal(report.collectionAddressProvided, false);
    assert.equal(report.salesOpen, false);
    assert.equal(report.readyToDeploy, false);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.transactionsSent, 0);
    assert.match(report.hiddenMetadataSha256, /^[a-f0-9]{64}$/);
    assert.ok(report.unverified.includes('collection existence and authorities'));
    assert.ok(report.unverified.includes('reserved asset creation'));
    assert.equal(fetchCalls, 0);
  });

  for (const [label, change] of [
    ['removed owner gate', value => { delete value.config.guardConfig.addressGate; }],
    ['another permitted wallet', value => { value.config.guardConfig.addressGate.address = otherAddress; }],
    ['discounted payment', value => { value.config.guardConfig.solPayment.lamports = '1'; }],
    ['redirected payment', value => { value.config.guardConfig.solPayment.destination = otherAddress; }],
    ['reserved NFT counted in public supply', value => { value.config.itemsAvailable = 10000; }],
  ]) test(`rejects ${label} in the saved machine configuration`, () => rejectChange('cm-config.json', change));

  test('does not accept a false collection value as an unconfigured address', async () => {
    await withJsonChange('cm-config.json', value => {
      value.config.collection = false;
    }, () => assert.rejects(verifyPreparation(directory), /Collection must be a public-key string or an empty string/));
  });

  for (const [label, change] of [
    ['reserved #0000 replacing a public item', value => {
      value.assetItems[0].name = 'CoolBears #0000 — Hidden Bear';
      value.assetItems[0].jsonUri = `${policy.website}/metadata/hidden/0000.json`;
    }],
    ['duplicate metadata URI', value => { value.assetItems[1].jsonUri = value.assetItems[0].jsonUri; }],
    ['non-contiguous machine indices', value => {
      value.assetItems[9999] = value.assetItems[9998];
      delete value.assetItems[9998];
    }],
    ['already-loaded item', value => { value.assetItems[4321].loaded = true; }],
  ]) test(`rejects cache containing ${label}`, () => rejectChange('asset-cache.json', change));

  for (const [label, change] of [
    ['changed royalty rate', value => { value.royalties.basisPoints = 0; }],
    ['redirected royalty recipient', value => { value.royalties.creators[0].address = otherAddress; }],
  ]) test(`rejects ${label}`, () => rejectChange('collection-plugins.json', change));

  test('rejects a reserved NFT assigned to another owner', () => rejectChange('release-plan.json', value => {
    value.reservedAsset.owner = otherAddress;
  }));

  for (const role of ['collectionUpdateAuthority', 'candyMachineAuthority', 'candyGuardAuthority']) {
    test(`rejects an unexpected ${role}`, () => rejectChange('release-plan.json', value => {
      value.requiredAuthorities[role] = otherAddress;
    }));
  }

  test('rejects a reserved NFT whose collection differs from the machine plan', () => rejectChange('release-plan.json', value => {
    value.reservedAsset.collection = otherAddress;
  }));

  test('detects reveal attributes in a middle metadata file without reflecting their values', async () => {
    const marker = 'PRIVATE_TEST_VALUE_MUST_NOT_APPEAR_IN_ERRORS';
    await withJsonChange('hidden/5000.json', value => {
      value.attributes = [{ trait_type: 'test-only trait', value: marker }];
    }, async () => {
      await assert.rejects(verifyPreparation(directory), error => {
        assert.equal(error.message, 'Preparation mismatch: hidden/5000.json');
        assert.ok(!String(error).includes(marker));
        return true;
      });
    });
  });

  test('detects a missing metadata file before claiming all 10,000 verified', async () => {
    const filename = path.join(directory, 'hidden/6732.json');
    const original = await readFile(filename);
    try {
      await unlink(filename);
      await assert.rejects(verifyPreparation(directory), /Preparation mismatch: hidden filenames/);
    } finally {
      await writeFile(filename, original, { flag: 'wx' });
    }
  });

  for (const flag of ['metadataPublished', 'collectionCreated', 'machineCreated', 'salesOpen']) {
    test(`does not validate an offline-only package claiming ${flag}`, () => rejectChange('preparation.json', value => {
      value[flag] = true;
    }));
  }

  test('a syntactically valid collection address remains unverified and not ready to deploy', async () => {
    // A system-program address is deliberately not an actual Core collection.
    // An offline report must distinguish address syntax from on-chain proof.
    await withJsonChange('cm-config.json', value => {
      value.config.collection = otherAddress;
    }, () => withJsonChange('release-plan.json', value => {
      value.collection = otherAddress;
      value.reservedAsset.collection = otherAddress;
    }, async () => {
      const report = await verifyPreparation(directory);
      assert.equal(report.collectionAddressProvided, true);
      assert.equal(report.readyToDeploy, false);
      assert.equal(report.reservedAssetCreated, false);
      assert.equal(report.transactionsSent, 0);
      assert.ok(report.unverified.includes('collection existence and authorities'));
      assert.equal(fetchCalls, 0);
    }));
  });
});
