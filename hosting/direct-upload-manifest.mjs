// Prepare the already-audited PR28 bytes for Cloudflare's official direct-upload API.
// No network or credentials. _headers is control metadata, never a served asset.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditTree, hash, readRegular, validateCandidate } from './audit.mjs';
import { hiddenFiles } from '../scripts/hidden-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidate = path.join(root, 'build/hosting-candidate');
const config = JSON.parse(await readFile(path.join(candidate, 'wrangler.json')));
validateCandidate(config);
const report = JSON.parse(await readFile(path.join(candidate, 'report.json')));
const approved = [...JSON.parse(await readFile(path.join(root, 'scripts/public-files.json'))),
  ...hiddenFiles().map(x => x.path)];
const expected = new Map();
for (const file of approved) {
  const bytes = await readRegular(root, file);
  expected.set(file, { bytes: bytes.length, sha256: hash(bytes) });
}
const headers = await readFile(path.join(root, 'hosting/headers.txt'), 'utf8');
expected.set('_headers', { bytes: Buffer.byteLength(headers), sha256: hash(headers) });
const audit = await auditTree(path.join(candidate, 'site'), expected);
assert.equal(audit.summary.manifestSha256, report.candidate.manifestSha256);
const manifest = {}, entries = [], hashBytes = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.mjs':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json', '.gif':'image/gif', '.png':'image/png', '.webp':'image/webp',
  '.txt':'text/plain; charset=utf-8', '.xml':'application/xml', '.ico':'image/x-icon' };
for (const file of approved.sort()) {
  const bytes = await readRegular(path.join(candidate, 'site'), file);
  const sha256 = hash(bytes), digest = createHash('md5').update(bytes).digest('hex');
  assert.ok(!hashBytes.has(digest) || hashBytes.get(digest) === sha256, 'ASSET_HASH_COLLISION');
  hashBytes.set(digest, sha256);
  const type = file === 'CNAME' ? 'text/plain; charset=utf-8' : mime[path.extname(file)];
  assert.ok(type, 'UNKNOWN_MIME_TYPE: ' + file);
  manifest['/' + file] = { hash: digest, size: bytes.length };
  entries.push({ path: file, hash: digest, sha256, size: bytes.length, type });
}
assert.equal(entries.length, 10031);
const metadata = { compatibility_date: config.compatibility_date,
  assets: { config: { html_handling: config.assets.html_handling,
    not_found_handling: config.assets.not_found_handling, run_worker_first: false, _headers: headers } },
  observability: { enabled: false } };
await writeFile(path.join(candidate, 'direct-upload.json'), JSON.stringify({
  sourceCommit: '5bce65e3735ac24f3a93a826d5143a96558049ff',
  candidateManifestSha256: audit.summary.manifestSha256, manifest, entries, metadata }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ files: entries.length, bytes: entries.reduce((n,x)=>n+x.size,0),
  controlFile: '_headers', candidateManifestSha256: audit.summary.manifestSha256 }));
