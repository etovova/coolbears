// Local allowlist/byte audit. No network, deployment, DNS or private inventory.
import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ files: 20000, fileBytes: 25 * 1024 * 1024 });
export const hash = data => createHash('sha256').update(data).digest('hex');
const need = (value, code) => assert.ok(value, code);
function validPath(value) {
  need(typeof value === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(value)
    && !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..'), 'INVALID_PUBLIC_PATH');
}
export async function readRegular(root, file) {
  validPath(file);
  need((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'UNSAFE_PUBLIC_ROOT');
  const parts = file.split('/'); let current = root;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part); const stat = await lstat(current);
    need(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'UNSAFE_PUBLIC_ENTRY');
    if (i === parts.length - 1) need(stat.size <= LIMITS.fileBytes, 'PUBLIC_FILE_TOO_LARGE');
  }
  return readFile(current);
}
export function validateCandidate(config) {
  assert.deepEqual(config, {
    name: 'coolbears-site-candidate', compatibility_date: '2026-09-23', workers_dev: false, preview_urls: false,
    assets: { directory: './site', html_handling: 'auto-trailing-slash', not_found_handling: 'none', run_worker_first: false },
    observability: { enabled: false },
  }, 'CANDIDATE_CONFIGURATION_CHANGED');
}
export async function auditTree(directory, expected) {
  need(expected instanceof Map && expected.size > 0 && expected.size <= LIMITS.files, 'INVALID_PUBLIC_MANIFEST');
  for (const file of expected.keys()) validPath(file);
  const directories = new Set(['']);
  for (const file of expected.keys()) {
    let parent = path.posix.dirname(file);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const found = [];
  async function walk(relative = '') {
    const folder = path.join(directory, relative), stat = await lstat(folder);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PUBLIC_ROOT');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      need(!entry.isSymbolicLink(), 'UNSAFE_PUBLIC_ENTRY');
      if (entry.isDirectory()) { need(directories.has(name), 'UNEXPECTED_PUBLIC_DIRECTORY'); await walk(name); }
      else { need(entry.isFile() && expected.has(name), 'UNEXPECTED_PUBLIC_FILE'); found.push(name); }
    }
  }
  await walk();
  need(found.length === expected.size, 'MISSING_PUBLIC_FILE');
  const entries = [];
  for (const file of found.sort()) {
    const bytes = await readRegular(directory, file), sha256 = hash(bytes), item = expected.get(file);
    need(bytes.length === item.bytes && sha256 === item.sha256, 'PUBLIC_BYTES_CHANGED');
    entries.push({ path: file, bytes: bytes.length, sha256 });
  }
  return { entries, summary: { files: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0), largestFileBytes: Math.max(...entries.map(e => e.bytes)),
    manifestSha256: hash(JSON.stringify(entries)), limits: LIMITS, withinFreeAssetLimits: true } };
}
