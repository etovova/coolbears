import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflightOrder } from './preflight.mjs';

async function readOrderFile(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 262144) throw Error('ORDER_FILE');
    const bytes = Buffer.alloc(262145); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > 262144) throw Error('ORDER_FILE');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}
export async function runOrderCheck(args, { env = process.env, output = process.stdout, fetchImpl } = {}) {
  if (args.length !== 2 || args[0] !== 'preflight') {
    output.write(JSON.stringify({ status: 'blocked', code: 'USAGE', transactionsSent: 0 }) + '\n'); return 1;
  }
  const report = await preflightOrder({ readOrder: () => readOrderFile(args[1]),
    endpoint: env.COOLBEARS_BUYER_RPC_URL, fetchImpl });
  // CLI is a diagnostic, not a handoff file. Do not print executable bytes,
  // private filesystem paths, RPC URL, credentials or arbitrary provider text.
  const { candidate, ...summary } = report;
  output.write(JSON.stringify(summary, null, 2) + '\n');
  return report.status === 'preflight-passed' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runOrderCheck(process.argv.slice(2));
