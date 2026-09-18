import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const plan = JSON.parse(await readFile('scripts/pinata-delete-plan.json', 'utf8'));
const token = process.env.PINATA_JWT;
if (!token || plan.version !== 'fresh-20260918' || plan.records.length !== 78) throw Error('Invalid cleanup inputs');
const result = [];
for (const file of plan.records) {
  if (!file.coolbears || !/cool[ _-]?bears?/i.test(file.name) || !['public', 'private'].includes(file.network) || !/^[a-f0-9-]{36}$/.test(file.id)) throw Error('File outside authorized CoolBears scope');
  const url = `https://api.pinata.cloud/v3/files/${file.network}/${file.id}`;
  const current = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
  if (current.status === 404) { result.push({ id: file.id, status: 'already-absent' }); continue; }
  if (!current.ok) { result.push({ id: file.id, status: 'read-failed', http: current.status }); continue; }
  const { data } = await current.json();
  if (data.name !== file.name || data.size !== file.size || createHash('sha256').update(data.cid || '').digest('hex') !== file.cid_sha256) throw Error(`File changed since inventory: ${file.id}`);
  const deleted = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
  result.push({ id: file.id, network: file.network, status: deleted.ok ? 'deleted' : 'delete-failed', http: deleted.status });
  console.log(JSON.stringify(result.at(-1)));
}
await mkdir('build', { recursive: true });
const report = { completedAt: new Date().toISOString(), planned: plan.records.length, deleted: result.filter(r => r.status === 'deleted').length, alreadyAbsent: result.filter(r => r.status === 'already-absent').length, failed: result.filter(r => r.status.endsWith('failed')).length, result };
await writeFile('build/pinata-cleanup.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ planned: report.planned, deleted: report.deleted, absent: report.alreadyAbsent, failed: report.failed }));
if (report.failed) process.exitCode = 1;
