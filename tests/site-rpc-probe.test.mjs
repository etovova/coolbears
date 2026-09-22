import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getCandyMachineAccountDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { checkSiteRpc, runSiteRpcCli } from '../scripts/check-site-rpc.mjs';
import { settings as S } from '../devnet/settings.mjs';

const endpoint = 'https://coolbears-rpc.workers.dev/rpc';
const origin = 'https://coolbears-nfts.com';
const fixture = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
const cors = { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'Retry-After' };
const preflightHeaders = { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Solana-Client' };
const never = () => new Promise(() => {});
function harness({ redeemed = 2n } = {}) {
  const accounts = structuredClone(fixture.getMultipleAccounts);
  const bytes = Buffer.from(accounts.value[0].data[0], 'base64');
  const serializer = getCandyMachineAccountDataSerializer();
  const [machine] = serializer.deserialize(bytes);
  bytes.set(serializer.serialize({ ...machine, itemsRedeemed: redeemed }));
  accounts.value[0].data[0] = bytes.toString('base64');
  const h = { calls: [], accounts };
  h.fetchImpl = async (url, options) => {
    assert.equal(url, endpoint); assert.equal(options.headers.origin, origin);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    h.calls.push(options);
    if (options.method === 'OPTIONS') {
      assert.equal(options.headers['access-control-request-method'], 'POST');
      assert.equal(options.headers['access-control-request-headers'], 'content-type,solana-client');
      return new Response(null, { status: 204, headers: preflightHeaders });
    }
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.ok(['getGenesisHash', 'getMultipleAccounts'].includes(request.method));
    if (request.method === 'getMultipleAccounts') {
      assert.deepEqual(request.params[0], [S.machine, S.guard, S.collection]);
      assert.equal(request.params[1].commitment, 'finalized');
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'getGenesisHash' ? S.genesis : h.accounts,
    }), { headers: cors });
  };
  return h;
}

test('read-only probe validates real Core accounts including the exhausted two-item lab', async () => {
  for (const redeemed of [1n, 2n]) {
    const h = harness({ redeemed });
    const result = await checkSiteRpc({ endpoint, fetchImpl: h.fetchImpl });
    assert.deepEqual(result, { ok: true, endpoint, cluster: 'devnet', readOnlyReady: true,
      itemsRedeemed: String(redeemed), itemsAvailable: '2', httpRequests: 3 });
    assert.deepEqual(h.calls.map(call => call.method === 'OPTIONS' ? 'OPTIONS' : JSON.parse(call.body).method),
      ['OPTIONS', 'getGenesisHash', 'getMultipleAccounts']);
  }
});

test('credential-bearing and nonpublic endpoints fail before any request and stay redacted', async () => {
  for (const value of ['http://coolbears-rpc.workers.dev/rpc', `${endpoint}?api-key=PRIVATE_TEST_SECRET`,
    'https://user:PRIVATE_TEST_SECRET@coolbears-rpc.workers.dev/rpc', 'https://127.0.0.1/rpc', 'https://localhost/rpc', `${endpoint}#PRIVATE_TEST_SECRET`]) {
    await assert.rejects(checkSiteRpc({ endpoint: value, fetchImpl: () => { assert.fail('No fetch expected'); } }), error =>
      error.code === 'ENDPOINT' && !String(error).includes('PRIVATE_TEST_SECRET'));
  }
});

test('preflight must succeed and permit exact site origin, POST, content-type and solana-client', async () => {
  for (const response of [
    new Response(null, { status: 403, headers: preflightHeaders }),
    new Response(null, { status: 204, headers: { ...preflightHeaders, 'access-control-allow-origin': '*' } }),
    new Response(null, { status: 204, headers: { ...preflightHeaders, 'access-control-allow-origin': 'https://other.com' } }),
    new Response(null, { status: 204, headers: { ...preflightHeaders, 'access-control-allow-methods': 'GET' } }),
    new Response(null, { status: 204, headers: { ...preflightHeaders, 'access-control-allow-headers': 'authorization' } }),
    new Response(null, { status: 204, headers: { ...preflightHeaders, 'access-control-allow-headers': 'content-type' } }),
  ]) {
    let calls = 0;
    await assert.rejects(checkSiteRpc({ endpoint, fetchImpl: async () => { calls++; return response; } }),
      error => error.code === (response.status === 403 ? 'HTTP' : 'CORS'));
    assert.equal(calls, 1);
  }
});

test('POST CORS requires exact origin and retry-after exposure even though Node does not enforce CORS', async () => {
  for (const headers of [{ 'access-control-expose-headers': 'retry-after' }, { 'access-control-allow-origin': origin }]) {
    const h = harness(); let calls = 0;
    await assert.rejects(checkSiteRpc({ endpoint, fetchImpl: async (url, options) => {
      calls++;
      if (options.method === 'OPTIONS') return h.fetchImpl(url, options);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: S.genesis }), { headers });
    } }), { code: 'CORS' });
    assert.equal(calls, 2);
  }
});

test('wrong genesis prevents the finalized account request', async () => {
  const h = harness(); let calls = 0;
  await assert.rejects(checkSiteRpc({ endpoint, fetchImpl: async (url, options) => {
    calls++;
    if (options.method === 'OPTIONS') return h.fetchImpl(url, options);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'wrong-genesis-PRIVATE_TEST_SECRET' }), { headers: cors });
  } }), error => error.code === 'GENESIS' && !String(error).includes('PRIVATE_TEST_SECRET'));
  assert.equal(calls, 2);
});

test('unexpected finalized machine configuration is rejected', async () => {
  const h = harness({ redeemed: 3n });
  await assert.rejects(checkSiteRpc({ endpoint, fetchImpl: h.fetchImpl }), { code: 'STATE' });
  assert.equal(h.calls.length, 3);
});

test('a single deadline bounds ignored abort signals and stalled OPTIONS or RPC bodies', async () => {
  for (const mode of ['fetch', 'preflight-body', 'rpc-body', 'error-body']) {
    const h = harness(); let observedSignal;
    const before = Date.now();
    await assert.rejects(checkSiteRpc({ endpoint, timeoutMs: 80, fetchImpl: async (url, options) => {
      observedSignal = options.signal;
      if (mode === 'fetch') return never();
      if (mode === 'preflight-body') return { ok: true, headers: new Headers(preflightHeaders), body: { cancel: never } };
      if (mode === 'error-body') return { ok: false, headers: new Headers(), body: { cancel: never } };
      if (options.method === 'OPTIONS') return h.fetchImpl(url, options);
      return { ok: true, status: 200, headers: new Headers(cors), text: never };
    } }), { code: 'TIMEOUT' });
    assert.equal(observedSignal.aborted, true);
    assert.ok(Date.now() - before < 1500, 'deadline bounds the whole probe including the body');
  }
});

test('network, HTTP and provider/schema failures never export raw messages or keys', async () => {
  for (const mode of ['network', 'http', 'jsonrpc', 'schema']) {
    const h = harness();
    await assert.rejects(checkSiteRpc({ endpoint, fetchImpl: async (url, options) => {
      if (options.method === 'OPTIONS') return h.fetchImpl(url, options);
      if (mode === 'network') throw Error('PRIVATE_TEST_SECRET');
      if (mode === 'http') return new Response('PRIVATE_TEST_SECRET', { status: 429, headers: cors });
      const request = JSON.parse(options.body);
      if (mode === 'schema' && request.method === 'getGenesisHash') return h.fetchImpl(url, options);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        ...(mode === 'jsonrpc' ? { error: { code: -32000, message: 'PRIVATE_TEST_SECRET' } } : { result: 'PRIVATE_TEST_SECRET' }),
      }), { headers: cors });
    } }), error => !String(error).includes('PRIVATE_TEST_SECRET') && !JSON.stringify(error).includes('PRIVATE_TEST_SECRET'));
  }
});

test('CLI returns small JSON and never prints invalid secret-bearing arguments', async () => {
  const h = harness(), output = [];
  assert.equal(await runSiteRpcCli(['--endpoint', endpoint], { fetchImpl: h.fetchImpl, write: value => output.push(value) }), 0);
  assert.equal(JSON.parse(output[0]).readOnlyReady, true);
  for (const args of [[], ['--endpoint', `${endpoint}?api-key=PRIVATE_TEST_SECRET`], ['--key', 'PRIVATE_TEST_SECRET']]) {
    const lines = [];
    assert.equal(await runSiteRpcCli(args, { write: line => lines.push(line), fetchImpl: () => assert.fail('No fetch expected') }), 1);
    assert.equal(lines.length, 1); assert.equal(lines[0].includes('PRIVATE_TEST_SECRET'), false);
    assert.equal(JSON.parse(lines[0]).readOnlyReady, false);
  }
});
