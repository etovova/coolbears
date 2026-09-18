import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const token = process.env.PINATA_JWT;
if (!token) throw Error('PINATA_JWT is not configured');
const records = [];
const errors = [];
for (const network of ['public', 'private']) {
  let cursor;
  const seen = new Set();
  do {
    const url = new URL(`https://api.pinata.cloud/v3/files/${network}`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('pageToken', cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
    if (!response.ok) { errors.push({ network, status: response.status }); break; }
    const { data } = await response.json();
    if (!Array.isArray(data?.files)) throw Error('Unexpected inventory response');
    for (const f of data.files) {
      const scoped = /cool[ _-]?bears?/i.test(f.name || '') || /coolbears/i.test(JSON.stringify(f.keyvalues || {}));
      records.push({ network, id: f.id, name: scoped ? f.name : '[unrelated]', size: f.size, coolbears: scoped, created_at: f.created_at, cid_sha256: createHash('sha256').update(f.cid || '').digest('hex') });
    }
    cursor = data.next_page_token;
    if (cursor && seen.has(cursor)) throw Error('Inventory pagination repeated');
    if (cursor) seen.add(cursor);
  } while (cursor);
}
await mkdir('build', { recursive: true });
const summary = { checkedAt: new Date().toISOString(), readOnly: true, records, errors };
await writeFile('build/pinata-inventory.json', JSON.stringify(summary, null, 2));
for (const record of records.filter(r => r.coolbears)) console.log(JSON.stringify(record));
console.log(JSON.stringify({ totals: { all: records.length, coolbears: records.filter(r => r.coolbears).length }, errors }));
if (errors.length) process.exitCode = 1;
