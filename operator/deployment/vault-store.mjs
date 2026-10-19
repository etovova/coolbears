// Private local custody bundle. This module never sees a passphrase or plaintext
// signer material, and has no key generation, wallet, RPC or submission API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createDeploymentJournal, readDeploymentJournal, sha256Json } from './journal.mjs';
import { validateCanonicalDeploymentManifest } from './intent.mjs';
import { validateDeploymentVaultEnvelope } from './vault.mjs';

const SMALL_FILE_LIMIT = 16384;
const JOURNAL_FILE_LIMIT = 16 * 1024 * 1024;
const PENDING = /^\.pending-[0-9a-f-]{36}$/;
const EVENTS = /^\d{8}\.json$/;
const READY_FIELDS = ['version', 'kind', 'id', 'cluster', 'manifestSha256', 'vaultSha256'];
class BundleError extends Error {
  constructor(code) {
    super('Deployment signer bundle could not be used.');
    this.code = `DEPLOYMENT_BUNDLE_${code}`;
  }
}
const check = (condition, code = 'INVALID') => { if (!condition) throw new BundleError(code); };
const safe = error => error instanceof BundleError ? error : new BundleError('INVALID');
function exact(value, fields) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  check(keys.length === fields.length && fields.every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined;
  }));
}
function directoryPath(directory) {
  check(typeof directory === 'string' && directory.length > 0 && !directory.includes('\0'), 'PATH');
  return path.resolve(directory);
}
function privateStat(stat, directory = false, limit = JOURNAL_FILE_LIMIT) {
  // POSIX ownership and permissions are a requirement, not simulated by chmod
  // on filesystems/platforms that cannot represent this security boundary.
  check(typeof process.getuid === 'function', 'PLATFORM');
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
  check(stat.uid === uid && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600), 'PERMISSIONS');
  check(directory ? stat.isDirectory() : stat.isFile(), 'PATH');
  if (!directory) check(Number.isSafeInteger(stat.size) && stat.size <= limit, 'SIZE');
}
async function realDirectories(directory) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH');
  }
}
async function privateDirectory(directory) {
  const stat = await lstat(directory);
  check(!stat.isSymbolicLink(), 'PATH');
  privateStat(stat, true);
  return stat;
}
async function privateFile(filename, limit = JOURNAL_FILE_LIMIT) {
  const stat = await lstat(filename);
  check(!stat.isSymbolicLink(), 'PATH');
  privateStat(stat, false, limit);
  return stat;
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { check((await handle.stat()).isDirectory(), 'PATH'); await handle.sync(); }
  finally { await handle.close(); }
}
async function readPrivateJson(filename, limit) {
  await privateFile(filename, limit);
  // NONBLOCK avoids hanging on a special file substituted before open; fstat
  // rejects it. O_NOFOLLOW independently rejects a substituted final symlink.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); privateStat(before, false, limit);
    const chunks = []; let size = 0;
    while (size <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead; check(size <= limit, 'SIZE'); chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(); privateStat(after, false, limit);
    const named = await privateFile(filename, limit);
    check(before.dev === named.dev && before.ino === named.ino && before.size === size
      && after.size === size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'CHANGED');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } finally { await handle.close(); }
}

async function publish(directory, filename, value) {
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  check(bytes.length <= SMALL_FILE_LIMIT, 'SIZE');
  const handle = await open(temporary, 'wx', 0o600);
  try { privateStat(await handle.stat(), false, SMALL_FILE_LIMIT); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  // Atomic no-replace publication. Failure deliberately leaves the incomplete
  // bundle and any temporary file intact for diagnosis; no automatic repair.
  await link(temporary, path.join(directory, filename));
  await syncDirectory(directory);
  await unlink(temporary);
  await syncDirectory(directory);
}

async function inspectTree(root, readyRequired = true) {
  await realDirectories(root);
  const rootStat = await privateDirectory(root);
  const entries = await readdir(root);
  check(entries.every(name => ['vault.json', 'journal', 'READY.json'].includes(name) || PENDING.test(name)));
  check(entries.includes('vault.json') && entries.includes('journal') && (!readyRequired || entries.includes('READY.json')), 'INCOMPLETE');
  for (const name of entries.filter(name => PENDING.test(name))) await privateFile(path.join(root, name), SMALL_FILE_LIMIT);
  await privateFile(path.join(root, 'vault.json'), SMALL_FILE_LIMIT);
  if (entries.includes('READY.json')) await privateFile(path.join(root, 'READY.json'), SMALL_FILE_LIMIT);
  const journalDirectory = path.join(root, 'journal');
  const journalStat = await privateDirectory(journalDirectory);
  const journalEntries = await readdir(journalDirectory);
  check(journalEntries.every(name => ['manifest.json', 'events', '.writer-lock'].includes(name) || PENDING.test(name)));
  check(journalEntries.includes('manifest.json') && journalEntries.includes('events'), 'INCOMPLETE');
  await privateFile(path.join(journalDirectory, 'manifest.json'));
  if (journalEntries.includes('.writer-lock')) await privateDirectory(path.join(journalDirectory, '.writer-lock'));
  for (const name of journalEntries.filter(name => PENDING.test(name))) await privateFile(path.join(journalDirectory, name));
  const eventsDirectory = path.join(journalDirectory, 'events');
  const eventsStat = await privateDirectory(eventsDirectory);
  const events = await readdir(eventsDirectory);
  check(events.every(name => EVENTS.test(name) || PENDING.test(name)));
  for (const name of events) await privateFile(path.join(eventsDirectory, name));
  return { journalDirectory, identities: [rootStat, journalStat, eventsStat].map(({ dev, ino }) => [dev, ino]) };
}

function readyFor(manifest, vault) {
  return { version: 1, kind: 'coolbears-deployment-bundle', id: manifest.id, cluster: manifest.cluster,
    manifestSha256: sha256Json(manifest), vaultSha256: sha256Json(vault) };
}

export async function createDeploymentBundle(input) {
  try {
    exact(input, ['directory', 'manifest', 'vault']);
    const root = directoryPath(input.directory);
    // Capture input synchronously so caller mutations during disk/SDK awaits
    // cannot change the encrypted envelope or reviewed deployment intent.
    const manifest = JSON.parse(JSON.stringify(input.manifest));
    assert.deepEqual(manifest, input.manifest);
    const vault = validateDeploymentVaultEnvelope(input.vault, manifest);
    await validateCanonicalDeploymentManifest(manifest);
    await realDirectories(path.dirname(root));
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new BundleError('EXISTS'); throw error; }
    await privateDirectory(root);
    await publish(root, 'vault.json', vault);
    await createDeploymentJournal(path.join(root, 'journal'), manifest);
    await inspectTree(root, false);
    await syncDirectory(root);
    await publish(root, 'READY.json', readyFor(manifest, vault));
    await syncDirectory(root);
    await syncDirectory(path.dirname(root));
    return await readDeploymentBundle(root);
  } catch (error) { throw safe(error); }
}

export async function readDeploymentBundle(directory) {
  try {
    const root = directoryPath(directory);
    const before = await inspectTree(root);
    const ready = await readPrivateJson(path.join(root, 'READY.json'), SMALL_FILE_LIMIT);
    exact(ready, READY_FIELDS);
    const manifest = await readPrivateJson(path.join(before.journalDirectory, 'manifest.json'), JOURNAL_FILE_LIMIT);
    const vault = validateDeploymentVaultEnvelope(await readPrivateJson(path.join(root, 'vault.json'), SMALL_FILE_LIMIT), manifest);
    check(sha256Json(ready) === sha256Json(readyFor(manifest, vault)), 'BINDING');
    await validateCanonicalDeploymentManifest(manifest);
    const snapshot = await readDeploymentJournal(before.journalDirectory);
    check(snapshot.manifestSha256 === ready.manifestSha256, 'CHANGED');
    const after = await inspectTree(root);
    check(sha256Json(before.identities) === sha256Json(after.identities), 'CHANGED');
    // Recheck immutable bindings after potentially long journal replay. A valid
    // appended journal prefix may advance independently; READY does not pin its
    // head and cannot detect restoration/deletion of a valid history suffix.
    check(sha256Json(await readPrivateJson(path.join(root, 'READY.json'), SMALL_FILE_LIMIT)) === sha256Json(ready), 'CHANGED');
    check(sha256Json(await readPrivateJson(path.join(root, 'vault.json'), SMALL_FILE_LIMIT)) === ready.vaultSha256, 'CHANGED');
    check(sha256Json(await readPrivateJson(path.join(before.journalDirectory, 'manifest.json'), JOURNAL_FILE_LIMIT)) === ready.manifestSha256, 'CHANGED');
    return { vault, journalDirectory: before.journalDirectory, snapshot };
  } catch (error) { throw safe(error); }
}
