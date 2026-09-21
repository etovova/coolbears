// Explicit server transport for this proxy environment; never a browser fallback.
import { spawn } from 'node:child_process';

export async function curlFetch(url, options = {}) {
  const args = ['--silent', '--show-error', '--max-time', '25', '--request', options.method || 'GET', '--write-out', '\n%{http_code}'];
  for (const [name, value] of new Headers(options.headers)) args.push('--header', `${name}: ${value}`);
  if (options.body != null) args.push('--data-binary', '@-');
  args.push(String(url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill(); reject(Error('RPC response too large')); }
      else chunks.push(chunk);
    });
    // curl diagnostics may contain a credential-bearing URL. Never forward them.
    child.stderr.resume();
    child.on('error', () => reject(Error('CURL_TRANSPORT_ABORTED')));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`CURL_TRANSPORT_${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(options.body ?? '');
  });
  const marker = result.lastIndexOf('\n');
  const status = Number(result.slice(marker + 1));
  return new Response(result.slice(0, marker), { status, headers: { 'content-type': 'application/json' } });
}
