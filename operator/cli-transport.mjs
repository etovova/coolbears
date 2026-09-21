// Load with node --import before the official CLI, or an SDK verification script.
// By default only reads/simulations are allowed. The send mode is Devnet lab only.
import assert from 'node:assert/strict';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { curlFetch } from './curl-transport.mjs';
import { base58 } from '@metaplex-foundation/umi/serializers';

const endpoint = process.env.COOLBEARS_RPC_URL;
assert.ok(endpoint, 'Explicit COOLBEARS_RPC_URL required');
const url = new URL(endpoint);
assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'HTTPS RPC required');
const nativeFetch = globalThis.fetch;
const devnet = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const laboratoryPayer = 'BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF';
const journal = process.env.COOLBEARS_LAB_OPERATION;
let sent = false;

async function saveExclusive(file, data) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

async function rpc(method, params = []) {
  const response = await curlFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.ok(response.ok, `RPC HTTP ${response.status}: ${method}`);
  const data = await response.json();
  assert.equal(data.id, 1);
  assert.ok(!data.error, `RPC error ${data.error?.code}: ${method}`);
  return data.result;
}

if (journal) {
  assert.ok(path.isAbsolute(journal), 'An absolute private operation directory is required');
  // This directory is also the run lock: a creation command cannot be repeated.
  await mkdir(journal, { mode: 0o700 });
  assert.equal(await rpc('getGenesisHash'), devnet, 'DEVNET_ONLY');
  await saveExclusive(path.join(journal, 'operation.json'), { createdAt: new Date().toISOString(), cluster: 'devnet', payer: laboratoryPayer, maxTransactions: 1 });
}

globalThis.fetch = async (request, options = {}) => {
  const requestedUrl = typeof request === 'string' || request instanceof URL ? String(request) : request.url;
  if (new URL(requestedUrl).href !== url.href) return nativeFetch(request, options);
  const body = JSON.parse(options.body);
  assert.ok(!Array.isArray(body), 'RPC batches are not used in the controlled CLI run');
  const method = body.method;
  if (process.env.COOLBEARS_RPC_TRACE === '1') console.error(`RPC ${method}`);
  if (method === 'sendTransaction') {
    assert.ok(journal, 'READ_ONLY_TRANSPORT: no operation directory');
    assert.equal(sent, false, 'ONE_TRANSACTION_PER_OPERATION');
    sent = true;
    assert.equal(body.params[1]?.encoding, 'base64', 'Base64 transaction required');
    const { VersionedTransaction } = await import('@solana/web3.js');
    const transaction = VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64'));
    assert.equal(transaction.message.staticAccountKeys[0].toBase58(), laboratoryPayer, 'LAB_PAYER_ONLY');
    const signature = base58.deserialize(transaction.signatures[0])[0];
    assert.ok(transaction.signatures[0].some(byte => byte !== 0), 'Missing payer signature');
    const simulation = await rpc('simulateTransaction', [body.params[0], { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
    assert.equal(simulation.value.err, null, `SIMULATION_FAILED: ${JSON.stringify(simulation.value.err)}`);
    await saveExclusive(path.join(journal, 'signed-transaction.json'), {
      signature, base64: body.params[0], blockhash: transaction.message.recentBlockhash,
      accounts: transaction.message.staticAccountKeys.map(key => key.toBase58()),
      simulation: simulation.value, preparedAt: new Date().toISOString(),
    });
    console.error(`Prepared Devnet transaction ${signature}`);
    // Exactly one forwarding attempt; the same signed bytes are stored first.
    const response = await curlFetch(endpoint, options);
    const text = await response.text();
    await saveExclusive(path.join(journal, 'submission.json'), { status: response.status, body: JSON.parse(text), checkedAt: new Date().toISOString() });
    assert.ok(response.ok, `RPC HTTP ${response.status}: sendTransaction. Inspect the saved signature; do not rerun.`);
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
  }
  assert.ok(method.startsWith('get') || ['simulateTransaction', 'isBlockhashValid'].includes(method), `RPC_METHOD_BLOCKED: ${method}`);
  const response = await curlFetch(endpoint, options);
  // Throw instead of letting web3.js automatically retry an HTTP 429.
  assert.ok(response.ok, `RPC HTTP ${response.status}: ${method}`);
  return response;
};
