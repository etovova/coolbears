import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcFetch, DEVNET_RPC, DEVNET_BACKUP_RPC, rpcErrorMessage } from '../chain/rpc.mjs';
import { GENESIS, SPEC } from '../chain/spec.mjs';
import { CoolBearsClient } from '../chain/runtime.mjs';
import { Journal, performOperation } from '../chain/journal.mjs';

const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function harness(handler, options = {}) {
  let clock = 100000;
  const calls = [], notices = [], waits = [];
  const fetch = createRpcFetch({ endpoint: DEVNET_RPC, cluster: 'devnet', now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; }, onProgress: s => notices.push(s),
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body); calls.push({ url, ...payload, time: clock });
      return await handler?.(url, payload, calls) || response({ jsonrpc: '2.0', id: payload.id,
        result: payload.method === 'getGenesisHash' ? GENESIS.devnet : null });
    }, ...options });
  return { calls, notices, waits, call: (method, params = []) => fetch(DEVNET_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }) };
}

test('HTTP 429 fails over to a genesis-checked Devnet endpoint and retains it', async () => {
  const h = harness(url => url.includes('api.devnet.solana.com') ? response({ error: { code: 429 } }, 429) : null);
  await h.call('getAccountInfo', [SPEC.owner]); await h.call('getBlockHeight');
  assert.deepEqual(h.calls.map(c => [new URL(c.url).host, c.method]), [
    ['api.devnet.solana.com', 'getGenesisHash'],
    [new URL(DEVNET_BACKUP_RPC).host, 'getGenesisHash'],
    [new URL(DEVNET_BACKUP_RPC).host, 'getAccountInfo'],
    [new URL(DEVNET_BACKUP_RPC).host, 'getBlockHeight'],
  ]);
  assert(h.notices.some(s => /резервное/.test(s)));
});

test('JSON 429 at HTTP 200 is retried only after Retry-After, on the custom URL', async () => {
  let reads = 0;
  const h = harness((_url, p) => p.method === 'getAccountInfo' && ++reads === 1
    ? response({ jsonrpc: '2.0', id: p.id, error: { code: 429, message: 'Connection rate limits exceeded' } }, 200, { 'Retry-After': '12' }) : null,
    { endpoint: 'https://custom.example/rpc' });
  await h.call('getAccountInfo');
  const attempts = h.calls.filter(c => c.method === 'getAccountInfo');
  assert.equal(attempts.length, 2); assert(attempts[1].time - attempts[0].time >= 12000);
  assert(h.calls.every(c => c.url === 'https://custom.example/rpc'));
});

test('Retry-After beyond the budget stops without hammering the endpoint', async () => {
  const h = harness(() => response({ error: { code: 429 } }, 429, { 'Retry-After': '120' }),
    { endpoint: 'https://custom.example/rpc' });
  await assert.rejects(h.call('getAccountInfo'), { code: 'RPC_BUSY' });
  assert.equal(h.calls.length, 1);
});

test('wrong-network backup never receives account data or transaction requests', async () => {
  const h = harness((url,p) => url.includes('api.devnet.solana.com') ? response({}, 503)
    : response({ jsonrpc: '2.0', id: p.id, result: GENESIS['mainnet-beta'] }));
  await assert.rejects(h.call('getAccountInfo'), /network does not match/);
  assert(h.calls.every(c => c.method === 'getGenesisHash'));
});

test('sendTransaction and requestAirdrop are never replayed on 429', async () => {
  for (const method of ['sendTransaction', 'requestAirdrop']) {
    const h = harness((_url,p) => p.method === method ? response({ error: { code: 429 } }, 429) : null);
    await assert.rejects(h.call(method), { code: 'RPC_BUSY' });
    assert.equal(h.calls.filter(c => c.method === method).length, 1);
    assert(!h.calls.some(c => c.url.includes('onfinality')));
  }
});

test('network loss during a read fails over, but transaction errors remain single attempts', async () => {
  let disconnected = false;
  const h = harness((url,p) => {
    if (p.method === 'getBlockHeight' && url.includes('api.devnet')) { disconnected = true; throw new TypeError('Failed to fetch'); }
    if (p.method === 'sendTransaction') throw new TypeError('Failed to fetch');
  });
  await h.call('getBlockHeight'); assert(disconnected);
  await assert.rejects(h.call('sendTransaction'), { code: 'RPC_UNAVAILABLE' });
  assert.equal(h.calls.filter(c => c.method === 'sendTransaction').length, 1);
});

test('parallel SDK reads are serialized and paced, with one genesis probe', async () => {
  const h = harness();
  await Promise.all([h.call('getBlockHeight'), h.call('getAccountInfo'), h.call('getSlot')]);
  assert.equal(h.calls.filter(c => c.method === 'getGenesisHash').length, 1);
  for (let i = 1; i < h.calls.length; i++) assert(h.calls[i].time - h.calls[i - 1].time >= 350);
});

test('semantic Solana errors are returned without retries or switching servers', async () => {
  const h = harness((_url,p) => p.method === 'simulateTransaction'
    ? response({ jsonrpc: '2.0', id: p.id, error: { code: -32602, message: 'Invalid params' } }) : null);
  assert.equal((await (await h.call('simulateTransaction')).json()).error.code, -32602);
  assert.equal(h.calls.filter(c => c.method === 'simulateTransaction').length, 1);
});

test('Umi and Web3 share the same rate-limited transport', async () => {
  const m = new Map(), c = new CoolBearsClient({ provider: { publicKey: SPEC.owner }, address: SPEC.owner,
    endpoint: DEVNET_RPC, storage: { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v) } });
  let fetched = 0;
  c.connection.getAccountInfo = async () => { fetched++; return null; };
  await c.umi.rpc.getAccount(SPEC.owner);
  assert.equal(fetched, 1);
});

test('wallet 429 keeps the operation unknown; resuming reconciles without another signature', async () => {
  const map = new Map(), journal = new Journal({ getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v) }, 'test');
  let prompts = 0, exists = false;
  const operation = { id: 'same-target', journal, inspect: async () => exists,
    prepare: async () => ({ transaction: {}, record: { target: 'original-address' } }),
    submit: async () => { prompts++; throw Error('429: Connection rate limits exceeded'); }, confirm: async () => false };
  await assert.rejects(performOperation(operation), /429/);
  assert.equal(journal.get('same-target').state, 'unknown');
  exists = true; await performOperation(operation);
  assert.equal(prompts, 1); assert.equal(journal.get('same-target').target, 'original-address');
  assert.equal(journal.get('same-target').state, 'confirmed');
  assert.match(rpcErrorMessage(Error('429: rate limits exceeded')), /Сохранённые операции не сброшены/);
});
