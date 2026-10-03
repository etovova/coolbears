// Explicit private files only. No discovery, uploads, wallet or network calls.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { analyzeRevealManifest, prepareRevealPayload } from './model.mjs';
const LIMIT = 64 * 1024 * 1024;
class StoreError extends Error {
  constructor(code) { super('Private reveal files could not be used.'); this.code = `REVEAL_FILE_${code}`; }
}
const check = (condition, code = 'INVALID') => { if (!condition) throw new StoreError(code); };
function owned(stat, directory = false, limit = LIMIT) {
  check(typeof process.getuid === 'function', 'PLATFORM');
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
  check(stat.uid === uid && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600), 'PERMISSIONS');
  check(directory ? stat.isDirectory() : stat.isFile(), 'TYPE');
  if (!directory) check(stat.size <= limit && Number.isSafeInteger(stat.size), 'SIZE');
}
async function directories(filename) {
  const parent = path.dirname(path.resolve(filename)), parsed = path.parse(parent);
  let current = parsed.root;
  for (const part of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current); check(stat.isDirectory() && !stat.isSymbolicLink(), 'PATH');
  }
  owned(await lstat(parent), true);
}
export async function readPrivateRevealBytes(filename, limit = LIMIT) {
  check(typeof filename === 'string' && filename.length > 0 && !filename.includes('\0'), 'PATH');
  check(Number.isSafeInteger(limit) && limit > 0 && limit <= LIMIT, 'SIZE');
  const absolute = path.resolve(filename); await directories(absolute);
  const stat = await lstat(absolute); check(!stat.isSymbolicLink(), 'PATH'); owned(stat, false, limit);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); owned(before, false, limit);
    check(before.ino === stat.ino && before.dev === stat.dev, 'CHANGED');
    const chunks = []; let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead; check(length <= limit, 'SIZE');
    }
    const bytes = Buffer.concat(chunks, length);
    const after = await handle.stat(); owned(after, false, limit);
    check(before.ino === after.ino && before.dev === after.dev && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.length === before.size, 'CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
export async function readPrivateRevealManifest(filename) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateRevealBytes(filename))); }
  catch (error) { if (String(error?.code).startsWith('REVEAL_FILE_')) throw error; throw new StoreError('JSON'); }
}
async function newDirectory(output) {
  check(typeof output === 'string' && output.length > 0 && !output.includes('\0'), 'PATH');
  const absolute = path.resolve(output); await directories(path.join(path.dirname(absolute), '.parent-check'));
  await mkdir(absolute, { recursive: false, mode: 0o700 }); owned(await lstat(absolute), true);
  return absolute;
}
async function save(filename, body) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); owned(await handle.stat()); }
  finally { await handle.close(); }
}
export async function saveRevealCommitment(output, manifest) {
  const report = analyzeRevealManifest(manifest), directory = await newDirectory(output);
  await save(path.join(directory, 'commitment.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
export async function stagePrivateReveal(output, manifest, options) {
  // All policy/hash/date/authorization/original-PNG checks happen before mkdir.
  const payload = await prepareRevealPayload(manifest, options), directory = await newDirectory(output);
  const hidden = path.join(directory, 'metadata', 'hidden');
  await mkdir(path.join(directory, 'metadata'), { mode: 0o700 }); await mkdir(hidden, { mode: 0o700 });
  await save(path.join(directory, 'content-proof.json'), payload.proofBody);
  await save(path.join(directory, 'runtime-config.json'), JSON.stringify(payload.runtimeConfig, null, 2) + '\n');
  for (const file of payload.files) await save(path.join(directory, file.path), file.body);
  const report = { version: 1, kind: payload.kind, commitmentSha256: payload.commitmentSha256,
    proofSha256: payload.proofSha256, preparedAt: payload.preparedAt, publicItems: payload.files.length, finalArtworkBytesVerified: true,
    marketplaceRefreshVerified: false, finalImageAvailabilityVerified: false, publicationPerformed: false, salesOpen: false, onchainRevealTransactions: 0 };
  // READY is last; a partial failure preserves files but does not mark ready.
  await save(path.join(directory, 'READY.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
