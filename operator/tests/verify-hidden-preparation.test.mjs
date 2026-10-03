// Synthetic digests exercise only offline preparation; they approve no launch.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, policy } from '../prepare.mjs';
import { verifyPreparation } from '../verify-preparation.mjs';

const hash = createHash('sha256').update('SYNTHETIC OFFLINE PREPARATION FIXTURE').digest('hex');
const otherHash = createHash('sha256').update('OTHER SYNTHETIC OFFLINE PREPARATION FIXTURE').digest('hex');
const options = { storageMode: 'hidden-settings', hiddenCommitmentSha256: hash };
const cli = fileURLToPath(new URL('../verify-preparation.mjs', import.meta.url));
const run = promisify(execFile);

describe('explicit trusted hidden preparation integrity', { concurrency: false }, () => {
  let temp, directory, originalFetch, fetchCalls = 0;

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = () => { fetchCalls++; throw Error('OFFLINE_NETWORK_FORBIDDEN'); };
    temp = await mkdtemp(path.join(os.tmpdir(), 'coolbears-verify-hidden-preparation-'));
    directory = path.join(temp, 'fresh-hidden-project');
    await prepare(directory, options);
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (temp) await rm(temp, { recursive: true, force: true });
    assert.equal(fetchCalls, 0, 'Offline preparation verification must never request network access');
  });

  async function withJsonChange(relative, change, check) {
    const filename = path.join(directory, relative);
    const original = await readFile(filename, 'utf8');
    try {
      const value = JSON.parse(original); change(value);
      await writeFile(filename, JSON.stringify(value) + '\n');
      await check();
    } finally { await writeFile(filename, original); }
  }
  const rejectChange = (relative, change) => withJsonChange(relative, change, () =>
    assert.rejects(verifyPreparation(directory, options), error =>
      error.message === `Preparation mismatch: ${relative}`));

  test('native hidden output verifies only against the explicit expected profile and digest', async () => {
    const report = await verifyPreparation(directory, options);
    assert.equal(report.status, 'offline-preparation-verified');
    assert.equal(report.storageMode, 'hidden-settings');
    assert.equal(report.hiddenCommitmentSha256, hash);
    assert.equal(report.metadataDocuments, 10000);
    assert.equal(report.indexedMetadataDocuments, 9999);
    assert.equal(report.machineItems, 9999);
    assert.equal(report.priceLamports, '200000000');
    assert.equal(report.royaltyBasisPoints, 700);
    assert.equal(report.reservedOwner, policy.owner);
    assert.equal(report.privateRevealMappingVerified, false);
    assert.equal(report.commitmentStatus, 'declared-unverified-private-mapping');
    assert.equal(report.configLineInsertions, 0);
    assert.equal(report.salesOpen, false);
    assert.equal(report.readyToDeploy, false);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.transactionsSent, 0);
    assert.ok(report.unverified.includes('private reveal mapping'));
  });

  test('the default legacy mode never auto-detects a hidden profile from files', async () => {
    await assert.rejects(verifyPreparation(directory), /Preparation mismatch: cm-config.json/);
    await assert.rejects(verifyPreparation(directory, { storageMode: 'config-lines' }), /Preparation mismatch: cm-config.json/);
  });

  test('a different externally expected digest rejects otherwise coherent hidden output', async () => {
    await assert.rejects(verifyPreparation(directory, { ...options, hiddenCommitmentSha256: otherHash }), /Preparation mismatch: cm-config.json/);
  });

  test('missing or malformed external digests fail before reading any package', async () => {
    for (const hiddenCommitmentSha256 of [undefined, '', null, '0'.repeat(64), 'f'.repeat(63), 'F'.repeat(64), 'g'.repeat(64), new Uint8Array(32)]) {
      await assert.rejects(verifyPreparation(path.join(temp, 'not-created'), {
        storageMode: 'hidden-settings', hiddenCommitmentSha256,
      }), /INVALID_HIDDEN_COMMITMENT_SHA256/);
    }
  });

  test('unknown modes and a digest without hidden mode fail before reading any package', async () => {
    for (const storageMode of ['hidden', '', null, {}, 'unknown']) {
      await assert.rejects(verifyPreparation(path.join(temp, 'not-created'), {
        storageMode, hiddenCommitmentSha256: hash,
      }), /INVALID_STORAGE_MODE/);
    }
    await assert.rejects(verifyPreparation(path.join(temp, 'not-created'), {
      hiddenCommitmentSha256: hash,
    }), /HIDDEN_COMMITMENT_REQUIRES_HIDDEN_SETTINGS/);
  });

  test('rewriting every persisted digest cannot substitute for the caller approval', () =>
    withJsonChange('cm-config.json', value => {
      value.config.hiddenSettings.hash = Array.from(Buffer.from(otherHash, 'hex'));
    }, () => withJsonChange('release-plan.json', value => {
      value.hiddenCommitmentSha256 = otherHash;
    }, () => withJsonChange('preparation.json', value => {
      value.hiddenCommitmentSha256 = otherHash;
    }, () => assert.rejects(verifyPreparation(directory, options), /Preparation mismatch: cm-config.json/)))));

  for (const [label, change] of [
    ['altered commitment bytes', value => { value.config.hiddenSettings.hash[0] ^= 1; }],
    ['inserted config lines', value => { value.config.configLineSettings = { isSequential: false }; }],
    ['removed owner gate', value => { delete value.config.guardConfig.addressGate; }],
    ['discounted payment', value => { value.config.guardConfig.solPayment.lamports = '1'; }],
  ]) test(`rejects ${label}`, () => rejectChange('cm-config.json', change));

  test('rejects config-line cache items in hidden mode', () => rejectChange('asset-cache.json', value => {
    value.assetItems[0] = { loaded: false };
  }));

  for (const [label, change] of [
    ['a private mapping verification claim', value => { value.privateRevealMappingVerified = true; }],
    ['a config-line insertion claim', value => { value.configLineInsertions = 1; }],
    ['a hidden profile mismatch', value => { value.storageMode = 'config-lines'; }],
  ]) test(`rejects preparation with ${label}`, () => rejectChange('preparation.json', change));

  test('rejects an upgraded commitment status in the native release plan', () => rejectChange('release-plan.json', value => {
    value.commitmentStatus = 'verified-private-mapping';
  }));

  test('indexed 10.json must match index 10 rather than sorted-array position', async () => {
    const marker = 'PRIVATE_TEST_MARKER_MUST_NOT_APPEAR_IN_ERRORS';
    await withJsonChange('hidden-indexed/10.json', value => {
      value.name = marker;
    }, () => assert.rejects(verifyPreparation(directory, options), error => {
      assert.equal(error.message, 'Preparation mismatch: hidden-indexed/10.json');
      assert.ok(!String(error).includes(marker));
      return true;
    }));
  });

  test('detects a missing indexed file', async () => {
    const filename = path.join(directory, 'hidden-indexed/6732.json');
    const original = await readFile(filename);
    try {
      await unlink(filename);
      await assert.rejects(verifyPreparation(directory, options), /Preparation mismatch: hidden-indexed filenames/);
    } finally { await writeFile(filename, original, { flag: 'wx' }); }
  });

  for (const filename of ['0.json', '0001.json', '10000.json']) {
    test(`rejects unexpected indexed filename ${filename}`, async () => {
      const extra = path.join(directory, 'hidden-indexed', filename);
      try {
        await writeFile(extra, '{}\n', { flag: 'wx' });
        await assert.rejects(verifyPreparation(directory, options), /Preparation mismatch: hidden-indexed filenames/);
      } finally { await unlink(extra); }
    });
  }

  test('an API call never inherits profile approval from process environment', async () => {
    const names = ['COOLBEARS_STORAGE_MODE', 'COOLBEARS_HIDDEN_COMMITMENT_SHA256'];
    const saved = names.map(name => process.env[name]);
    try {
      process.env.COOLBEARS_STORAGE_MODE = options.storageMode;
      process.env.COOLBEARS_HIDDEN_COMMITMENT_SHA256 = hash;
      await assert.rejects(verifyPreparation(directory), /Preparation mismatch: cm-config.json/);
    } finally {
      names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    }
  });

  test('CLI forwards explicit profile env and keeps mismatch output generic', async () => {
    const env = { ...process.env, COOLBEARS_STORAGE_MODE: options.storageMode, COOLBEARS_HIDDEN_COMMITMENT_SHA256: hash };
    const result = await run(process.execPath, [cli, directory], { env });
    assert.equal(JSON.parse(result.stdout).hiddenCommitmentSha256, hash);
    await assert.rejects(run(process.execPath, [cli, directory], {
      env: { ...env, COOLBEARS_HIDDEN_COMMITMENT_SHA256: otherHash },
    }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.ok(error.stderr.includes('Offline preparation check failed.'));
      assert.ok(!error.stderr.includes(hash) && !error.stderr.includes(otherHash));
      return true;
    });
  });

  test('unrecognised metadataBase options cannot approve a different metadata origin', async () => {
    const custom = path.join(temp, 'custom-origin');
    const metadataBase = 'https://other.invalid/metadata/hidden/';
    await prepare(custom, { metadataBase });
    await assert.rejects(verifyPreparation(custom, { metadataBase }), /Preparation mismatch: (?:cm-config|asset-cache)\.json/);
  });
});
