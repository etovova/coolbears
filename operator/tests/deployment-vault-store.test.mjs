// Disposable local custody bundle only. No owner private key, real deployment,
// network request or transaction submission is used by these filesystem tests.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle, readDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, nextDeploymentAction, sha256Json } from '../deployment/journal.mjs';

let temp, directory, fixture, handle, created, originalFetch, networkCalls = 0;
const passphrase = Buffer.from('disposable-storage-test-passphrase-only');
const safeError = error => /^DEPLOYMENT_BUNDLE_[A-Z]+$/.test(error.code)
  && error.message === 'Deployment signer bundle could not be used.' && error.cause === undefined;
const rejects = promise => assert.rejects(promise, safeError);

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw Error('Network forbidden in bundle tests'); };
  temp = await mkdtemp(path.join(os.tmpdir(), 'coolbears-vault-store-'));
  directory = path.join(temp, 'bundle');
  fixture = await createDeploymentSignerVault({ id: 'private-bundle-fixture', cluster: 'devnet',
    blockhash: new PublicKey(new Uint8Array(32).fill(72)).toBase58(), lastValidBlockHeight: 1000,
    machineRentLamports: '5000000000', passphrase });
  created = await createDeploymentBundle({ directory, ...fixture });
  handle = await openDeploymentSignerVault({ ...fixture, passphrase });
});
after(async () => {
  handle?.dispose(); passphrase.fill(0); globalThis.fetch = originalFetch;
  if (temp) await rm(temp, { recursive: true, force: true });
  assert.equal(networkCalls, 0);
});

async function mutateFile(relative, transform, check = () => rejects(readDeploymentBundle(directory))) {
  const filename = path.join(directory, relative), original = await readFile(filename);
  try { await writeFile(filename, transform(original)); await check(); }
  finally { await writeFile(filename, original); }
}
const mutateJson = (relative, change, check) => mutateFile(relative, original => {
  const value = JSON.parse(original); change(value); return JSON.stringify(value) + '\n';
}, check);

test('stable reload preserves the encrypted envelope and manifest with private owned files', async () => {
  const loaded = await readDeploymentBundle(directory);
  assert.deepEqual(loaded, created);
  assert.deepEqual(loaded.vault, fixture.vault);
  assert.equal(loaded.journalDirectory, path.join(directory, 'journal'));
  assert.equal(loaded.snapshot.revision, 0);
  assert.equal(loaded.snapshot.manifest.steps.length, 1431);
  assert.deepEqual(nextDeploymentAction(loaded.snapshot), { type: 'prepare', stepId: 'collection-create' });
  assert.deepEqual((await readdir(directory)).sort(), ['READY.json', 'journal', 'vault.json']);
  for (const relative of ['', 'journal', 'journal/events']) assert.equal((await stat(path.join(directory, relative))).mode & 0o777, 0o700);
  for (const relative of ['READY.json', 'vault.json', 'journal/manifest.json']) {
    const details = await stat(path.join(directory, relative));
    assert.equal(details.mode & 0o777, 0o600);
    assert.equal(details.uid, process.geteuid());
  }
  const ready = JSON.parse(await readFile(path.join(directory, 'READY.json'), 'utf8'));
  assert.deepEqual(ready, { version: 1, kind: 'coolbears-deployment-bundle', id: fixture.manifest.id,
    cluster: fixture.manifest.cluster, manifestSha256: sha256Json(fixture.manifest), vaultSha256: sha256Json(fixture.vault) });
  const vaultText = await readFile(path.join(directory, 'vault.json'), 'utf8');
  assert.ok(!vaultText.includes(passphrase.toString()));
  assert.deepEqual(Object.keys(loaded).sort(), ['journalDirectory', 'snapshot', 'vault']);
});

test('ready marker binds custody while allowing valid append-only journal progress', async () => {
  const marker = await readFile(path.join(directory, 'READY.json'));
  const vaultBytes = await readFile(path.join(directory, 'vault.json'));
  const step = fixture.manifest.steps[0];
  const request = handle.partialSign({ stepId: step.id, transactionBase64: step.transactionBase64,
    lastValidBlockHeight: step.lastValidBlockHeight, attempt: 1 });
  const tx = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
  assert.ok(tx.signatures[0].every(byte => byte === 0), 'Only the disposable asset signer is used');
  await appendDeploymentEvent(created.journalDirectory, { type: 'prepare', stepId: step.id, request, retry: false }, { expectedRevision: 0 });
  const loaded = await readDeploymentBundle(directory);
  assert.equal(loaded.snapshot.revision, 1);
  assert.deepEqual(nextDeploymentAction(loaded.snapshot), { type: 'reconcile', stepId: step.id, attempt: 1 });
  assert.deepEqual(await readFile(path.join(directory, 'READY.json')), marker);
  assert.deepEqual(await readFile(path.join(directory, 'vault.json')), vaultBytes);
  assert.equal((await stat(path.join(created.journalDirectory, 'events/00000001.json'))).mode & 0o777, 0o600);
});

test('duplicate creation cannot replace a vault or reset an existing journal', async () => {
  const before = await readFile(path.join(directory, 'journal/events/00000001.json'));
  const marker = await readFile(path.join(directory, 'READY.json'));
  await assert.rejects(createDeploymentBundle({ directory, ...fixture }), error => safeError(error) && error.code === 'DEPLOYMENT_BUNDLE_EXISTS');
  assert.deepEqual(await readFile(path.join(directory, 'journal/events/00000001.json')), before);
  assert.deepEqual(await readFile(path.join(directory, 'READY.json')), marker);
});

test('missing readiness or an incomplete directory stays intact and is never repaired or recreated', async () => {
  const filename = path.join(directory, 'READY.json'), backup = path.join(temp, 'saved-ready.json');
  await rename(filename, backup);
  try {
    await rejects(readDeploymentBundle(directory));
    await rejects(createDeploymentBundle({ directory, ...fixture }));
    assert.equal((await readdir(directory)).includes('READY.json'), false);
    assert.ok((await readdir(directory)).includes('vault.json'));
  } finally { await rename(backup, filename); }
  const incomplete = path.join(temp, 'interrupted'); await mkdir(incomplete, { mode: 0o700 });
  const retained = path.join(incomplete, 'vault.json');
  await writeFile(retained, 'retained incomplete encrypted data', { mode: 0o600 });
  await rejects(readDeploymentBundle(incomplete));
  await rejects(createDeploymentBundle({ directory: incomplete, ...fixture }));
  assert.equal(await readFile(retained, 'utf8'), 'retained incomplete encrypted data');
  assert.deepEqual(await readdir(incomplete), ['vault.json']);
});

test('changed ciphertext, foreign vault headers and altered readiness bindings fail before use', async () => {
  await mutateJson('vault.json', vault => {
    const ciphertext = Buffer.from(vault.ciphertextBase64, 'base64'); ciphertext[0] ^= 1;
    vault.ciphertextBase64 = ciphertext.toString('base64');
  });
  await mutateJson('vault.json', vault => { vault.id = 'another-deployment'; });
  await mutateJson('vault.json', vault => { vault.manifestSha256 = 'b'.repeat(64); });
  for (const change of [
    ready => { ready.vaultSha256 = 'b'.repeat(64); },
    ready => { ready.manifestSha256 = 'b'.repeat(64); },
    ready => { ready.cluster = 'mainnet-beta'; },
    ready => { ready.extra = true; },
  ]) await mutateJson('READY.json', change);
});

test('coherently rebound hashes cannot bless noncanonical deployment instructions or expected effects', async () => {
  const manifest = structuredClone(fixture.manifest);
  manifest.steps[0].expected.name = 'not the approved collection';
  const vault = { ...fixture.vault, manifestSha256: sha256Json(manifest) };
  const rejectedDirectory = path.join(temp, 'noncanonical');
  await rejects(createDeploymentBundle({ directory: rejectedDirectory, manifest, vault }));
  await assert.rejects(lstat(rejectedDirectory), { code: 'ENOENT' });
  const replacements = new Map([
    ['journal/manifest.json', manifest], ['vault.json', vault],
    ['READY.json', { version: 1, kind: 'coolbears-deployment-bundle', id: manifest.id,
      cluster: manifest.cluster, manifestSha256: sha256Json(manifest), vaultSha256: sha256Json(vault) }],
  ]);
  const originals = new Map();
  try {
    for (const [relative, value] of replacements) {
      const filename = path.join(directory, relative); originals.set(filename, await readFile(filename));
      await writeFile(filename, JSON.stringify(value));
    }
    await rejects(readDeploymentBundle(directory));
  } finally { for (const [filename, bytes] of originals) await writeFile(filename, bytes); }
});

test('unsafe permissions anywhere in the used bundle or journal fail without automatic chmod', async () => {
  for (const relative of ['', 'vault.json', 'READY.json', 'journal', 'journal/manifest.json', 'journal/events', 'journal/events/00000001.json']) {
    const filename = path.join(directory, relative), before = await stat(filename);
    const unsafeMode = before.isDirectory() ? 0o755 : 0o644;
    try {
      await chmod(filename, unsafeMode);
      await rejects(readDeploymentBundle(directory));
      assert.equal((await stat(filename)).mode & 0o777, unsafeMode);
    } finally { await chmod(filename, before.mode & 0o777); }
  }
});

test('files owned by a different user are rejected when the test process can change ownership', async t => {
  if (process.geteuid() !== 0) return t.skip('Changing file ownership requires root; the permission cases still run.');
  const filename = path.join(directory, 'vault.json'), original = await stat(filename);
  let changed = false;
  try {
    try { await chown(filename, 65534, original.gid); changed = true; }
    catch (error) {
      if (['EINVAL', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
        return t.skip('The filesystem or user namespace cannot assign a foreign UID; ownership rejection is not exercised here.');
      }
      throw error;
    }
    await rejects(readDeploymentBundle(directory));
    assert.equal((await stat(filename)).uid, 65534);
  } finally { if (changed) await chown(filename, original.uid, original.gid); }
});

test('symlink roots, parent components, journal directories and final files are rejected', async () => {
  const alias = path.join(temp, 'bundle-link'); await symlink(directory, alias, 'dir');
  await rejects(readDeploymentBundle(alias));
  await rejects(createDeploymentBundle({ directory: alias, ...fixture }));
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  const parentAlias = path.join(temp, 'parent-link'); await symlink(temp, parentAlias, 'dir');
  await rejects(readDeploymentBundle(path.join(parentAlias, 'bundle')));
  let index = 0;
  for (const relative of ['vault.json', 'READY.json', 'journal', 'journal/manifest.json', 'journal/events', 'journal/events/00000001.json']) {
    const filename = path.join(directory, relative), saved = path.join(temp, `link-target-${index++}`);
    const isDirectory = (await stat(filename)).isDirectory();
    await rename(filename, saved);
    try {
      await symlink(saved, filename, isDirectory ? 'dir' : 'file');
      await rejects(readDeploymentBundle(directory));
    } finally { await unlink(filename); await rename(saved, filename); }
  }
});

test('malformed, oversized or secret-like file contents produce only sanitized failures', async () => {
  const marker = 'PRIVATE_TEST_MARKER_NEVER_REFLECT';
  for (const relative of ['vault.json', 'READY.json', 'journal/manifest.json']) {
    await mutateFile(relative, () => Buffer.from(`{"broken":"${marker}`), async () => {
      await assert.rejects(readDeploymentBundle(directory), error => safeError(error) && !String(error).includes(marker));
    });
  }
  await mutateFile('vault.json', () => Buffer.alloc(16385, 32));
  await mutateFile('journal/manifest.json', () => Buffer.alloc(16 * 1024 * 1024 + 1, 32));
});

test('an immutable unfinished temporary file is preserved without becoming a readiness or journal event', async () => {
  const filename = path.join(directory, '.pending-00000000-0000-0000-0000-000000000001');
  const bytes = 'incomplete encrypted staging bytes';
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const bundle = await readDeploymentBundle(directory);
    assert.equal(bundle.snapshot.revision, 1);
    assert.equal(await readFile(filename, 'utf8'), bytes);
  } finally { await unlink(filename); }
});
