import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readDeploymentBundle } from '../vault-store.mjs';
import { nextDeploymentAction } from '../journal.mjs';
import { readDeploymentQueue, queueBinding } from '../queue.mjs';
import { createSigningSession } from './session.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDeploymentSigning } from '../handoff.mjs';
import { readPassphrase } from '../passphrase.mjs';
import { createGatewayFetch } from '../gateway/client.mjs';
import { startSigningConsole } from './server.mjs';
async function responseFile(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 16384) throw Error();
    const buffer = Buffer.alloc(16385); let size = 0;
    while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > 16384) throw Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    if (value?.status !== 'signed' || typeof value.requestId !== 'string' || typeof value.transactionBase64 !== 'string') throw Error();
    return value;
  } finally { await file?.close(); }
}
export async function runOwnerConsole(args, { input = process.stdin, output = process.stdout, errorOutput = process.stderr, env = process.env } = {}) {
  let passphrase;
  try {
    const [command, directory, suppliedStep, ...extra] = args;
    const needsStep = ['prepare', 'prepare-retry', 'import-response'].includes(command);
    if (!['status', 'prepare-next', 'prepare', 'prepare-retry', 'serve', 'import-response'].includes(command)
      || !directory || extra.length || (needsStep ? !suppliedStep : suppliedStep !== undefined)) throw Error();
    if (command === 'status') {
      output.write(JSON.stringify(await readDeploymentQueue(directory), null, 2) + '\n'); return 0;
    }
    if (command === 'import-response') {
      const response = await responseFile(suppliedStep);
      const session = await createSigningSession({ directory });
      const result = await session.accept(response.requestId, response.transactionBase64);
      output.write(JSON.stringify(result) + '\n'); return 0;
    }
    const endpoint = env.COOLBEARS_RPC_URL;
    const fetchImpl = env.COOLBEARS_OPERATOR_RPC_TOKEN === undefined ? undefined : createGatewayFetch({ endpoint, token: env.COOLBEARS_OPERATOR_RPC_TOKEN });
    if (['prepare', 'prepare-retry', 'prepare-next'].includes(command)) {
      // A pending request is resumed, never silently replaced or re-signed.
      const bundle = await readDeploymentBundle(directory), action = nextDeploymentAction(bundle.snapshot);
      const stepId = command === 'prepare-next' ? action.stepId : suppliedStep;
      const retry = command === 'prepare-retry';
      if (bundle.snapshot.manifest.cluster !== 'devnet'
        || action.type !== (retry ? 'retry-review' : 'prepare') || action.stepId !== stepId) {
        errorOutput.write('This step cannot be prepared. Resume the existing request or reconcile its outcome.\n'); return 1;
      }
      const expectedBinding = queueBinding(bundle.snapshot);
      passphrase = await readPassphrase({ input, output: errorOutput });
      const result = await prepareDeploymentSigning({ directory, stepId, passphrase, endpoint, fetchImpl, retry, expectedBinding });
      output.write(JSON.stringify({ status: 'request-saved', stepId, ...result.binding, ownerSignatureCreated: false, transactionsSent: 0 }) + '\n');
      return 0;
    }
    // The URL is a local secret capability. Print only to the owner's local TTY.
    if (output.isTTY !== true) throw Error();
    const console = await startSigningConsole({ directory, endpoint, fetchImpl });
    output.write(`Open locally; keep this link private:\n${console.url}\n`);
    const stop = () => { void console.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return 0;
  } catch {
    errorOutput.write('Owner console stopped. Check the private bundle, RPC configuration and local build. No transaction was sent.\n'); return 1;
  } finally { passphrase?.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runOwnerConsole(process.argv.slice(2));
