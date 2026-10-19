// Read-only hosting diagnostics while public DNS caches still reference the old host.
// Keeps the real URL/Host/TLS name; only the connection target is selected explicitly.
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
export async function edgeRequest(url, ip, options = {}) {
  assert.equal(isIP(ip), 4, 'Explicit IPv4 edge address required');
  const target = new URL(url);
  assert.equal(target.origin, 'https://coolbears-nfts.com');
  const temporary = await mkdtemp(path.join(tmpdir(), 'coolbears-edge-'));
  const headerFile = path.join(temporary, 'headers');
  const args = ['--silent', '--show-error', '--max-time', '25', '--connect-to',
    `${target.hostname}:443:${ip}:443`, '--dump-header', headerFile];
  if (options.method === 'HEAD') args.push('--head');
  else args.push('--request', options.method ?? 'GET');
  for (const [name, value] of new Headers(options.headers)) args.push('--header', `${name}: ${value}`);
  if (options.body !== undefined) args.push('--data-binary', '@-');
  args.push(target.href);
  let bytes, rawHeaders;
  try {
    bytes = await new Promise((resolve, reject) => {
      const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal });
      const output = []; let size = 0;
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { child.kill(); reject(Error('HTTP response too large')); }
        else output.push(chunk);
      });
      child.on('error', reject);
      child.on('close', code => code === 0
        ? resolve(Buffer.concat(output))
        : reject(Error(`CURL_EXIT_${code}`)));
      child.stdin.on('error', () => {}); child.stdin.end(options.body ?? '');
    });
    rawHeaders = await readFile(headerFile, 'utf8');
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const block = rawHeaders.trim().split(/\r?\n\r?\n/).filter(x => x.startsWith('HTTP/')).at(-1);
  assert.ok(block, 'Missing HTTP headers');
  const [statusLine, ...lines] = block.split(/\r?\n/), headers = new Headers();
  for (const line of lines) { const colon = line.indexOf(':'); if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
  return { response: { status: Number(statusLine.split(' ')[1]), headers }, body: options.method === 'HEAD' ? Buffer.alloc(0) : bytes };
}
