import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditTree, hash, validateCandidate, readRegular } from './audit.mjs';
import config from './candidate.json' with { type: 'json' };

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-hosting-'));
  try {
    await writeFile(path.join(root, 'index.html'), 'approved');
    const expected = new Map([['index.html', { bytes: 8, sha256: hash('approved') }]]);
    await fn(root, expected);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('artifact fingerprint binds exact paths and bytes', async () => fixture(async (root, expected) => {
  const good = await auditTree(root, expected);
  assert.equal(good.summary.files, 1); assert.equal(good.summary.totalBytes, 8);
  await writeFile(path.join(root, 'index.html'), 'tampered');
  await assert.rejects(auditTree(root, expected), /PUBLIC_BYTES_CHANGED/);
}));
test('unapproved file, missing file and private directory stop the build', async () => {
  await fixture(async (root, expected) => {
    await writeFile(path.join(root, 'secret.json'), 'never publish');
    await assert.rejects(auditTree(root, expected), /UNEXPECTED_PUBLIC_FILE/);
  });
  await fixture(async (root, expected) => {
    await rm(path.join(root, 'index.html')); await assert.rejects(auditTree(root, expected), /MISSING_PUBLIC_FILE/);
  });
  await fixture(async (root, expected) => {
    await mkdir(path.join(root, 'private')); await assert.rejects(auditTree(root, expected), /UNEXPECTED_PUBLIC_DIRECTORY/);
  });
});
test('symlinks, unsafe manifest paths and symlinked source parents are rejected', async () => fixture(async (root, expected) => {
  await rm(path.join(root, 'index.html')); await symlink('/etc/passwd', path.join(root, 'index.html'));
  await assert.rejects(auditTree(root, expected), /UNSAFE_PUBLIC_ENTRY/);
  for (const bad of ['../file', '/file', 'dir/../file', 'dir//file', 'file%2fsecret', 'a\\b']) {
    await assert.rejects(auditTree(root, new Map([[bad, { bytes: 1, sha256: hash('x') }]])), /INVALID_PUBLIC_PATH/);
  }
  await symlink('/etc', path.join(root, 'parent'));
  await assert.rejects(readRegular(root, 'parent/passwd'), /UNSAFE_PUBLIC_ENTRY/);
}));
test('provider per-file limit is checked before reading bytes', async () => fixture(async (root, expected) => {
  const { open } = await import('node:fs/promises');
  const file = await open(path.join(root, 'index.html'), 'w');
  try { await file.truncate(25 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(auditTree(root, expected), /PUBLIC_FILE_TOO_LARGE/);
}));
test('candidate cannot silently add a Worker, public route, preview or SPA fallback', () => {
  validateCandidate(config);
  for (const change of [c => { c.main = 'worker.mjs'; }, c => { c.routes = ['coolbears-nfts.com/*']; },
    c => { c.workers_dev = true; }, c => { c.preview_urls = true; },
    c => { c.assets.run_worker_first = true; }, c => { c.assets.not_found_handling = 'single-page-application'; },
    c => { c.assets.directory = '../private'; }]) {
    const copy = structuredClone(config); change(copy);
    assert.throws(() => validateCandidate(copy), /CANDIDATE_CONFIGURATION_CHANGED/);
  }
});
