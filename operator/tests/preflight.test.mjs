import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRpc, validateEndpoint, DEVNET } from '../preflight.mjs';

function rpc(responder) {
  const requests = [];
  return { requests, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request.method);
    assert.ok(init.signal instanceof AbortSignal);
    return responder(request);
  } };
}
const response = (request, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
const values = {
  getGenesisHash: DEVNET,
  getMultipleAccounts: { context: { slot: 500 }, value: Array.from({ length: 3 }, () => ({ executable: true })) },
  getBalance: { context: { slot: 501 }, value: 123456789 },
  getLatestBlockhash: { context: { slot: 501 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 900 } },
};
const endpoint = 'https://rpc.example.invalid/?api-key=not-a-real-key';

test('RPC config is explicit, has no fallback and refuses insecure transport', async () => {
  assert.throws(() => validateEndpoint(), /required/);
  assert.throws(() => validateEndpoint('http://rpc.example.invalid'));
  assert.throws(() => validateEndpoint('https://user:secret@rpc.example.invalid'));
  await assert.rejects(checkRpc(), /required/);
});

test('complete preflight uses four ordered read methods and makes no readiness claim about minting', async () => {
  const stub = rpc(request => response(request, values[request.method]));
  const result = await checkRpc({ endpoint, fetchImpl: stub.fetchImpl });
  assert.equal(result.status, 'read-path-passed');
  assert.deepEqual(stub.requests, Object.keys(values));
  assert.equal(result.writes, 0);
  assert.equal(result.simulationVerified, false);
  assert.equal(result.walletVerified, false);
  assert.ok(!JSON.stringify(result).includes('api-key'));
});

test('wrong cluster stops before reading accounts or funds', async () => {
  const stub = rpc(request => response(request, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'));
  const result = await checkRpc({ endpoint, fetchImpl: stub.fetchImpl });
  assert.equal(result.status, 'blocked');
  assert.match(result.code, /WRONG_NETWORK/);
  assert.deepEqual(stub.requests, ['getGenesisHash']);
});

test('429 stops at the first response without retry or signing', async () => {
  const stub = rpc(() => new Response('limited', { status: 429, headers: { 'retry-after': '60' } }));
  const result = await checkRpc({ endpoint, fetchImpl: stub.fetchImpl });
  assert.match(result.code, /RPC_HTTP_429/);
  assert.equal(stub.requests.length, 1);
  assert.equal(result.writes, 0);
});

test('missing programs, malformed responses and RPC errors block subsequent requests', async () => {
  for (const kind of ['missing-program', 'id-mismatch', 'rpc-error']) {
    const stub = rpc(request => {
      if (kind === 'id-mismatch') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 900, result: DEVNET }));
      if (kind === 'rpc-error') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32005 } }));
      if (request.method === 'getMultipleAccounts') return response(request, { context: { slot: 1 }, value: [null, null, null] });
      return response(request, values[request.method]);
    });
    const result = await checkRpc({ endpoint, fetchImpl: stub.fetchImpl });
    assert.equal(result.status, 'blocked');
    assert.ok(stub.requests.length <= 2);
  }
});

test('transport failure redacts the endpoint credential', async () => {
  const result = await checkRpc({ endpoint, fetchImpl: async () => { throw Error(`cannot fetch ${endpoint}`); } });
  assert.equal(result.status, 'blocked');
  assert.ok(!JSON.stringify(result).includes('not-a-real-key'));
});
