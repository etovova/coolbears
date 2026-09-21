import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VersionedTransaction } from '@solana/web3.js';
import { createClient, prepareMint, makeReadFetch, assertState, assertAsset, readOperation, saveOperation, mayStart, inspectOperation, withMintLock, boundedWalletCall } from '../devnet/core.mjs';
import { settings as S } from '../devnet/settings.mjs';
import { getWallets } from '@wallet-standard/app';
import { connectWallet } from '../devnet/wallet.mjs';

const op = () => ({ version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection, owner: S.owner, asset: 'J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57', blockhash: S.machine, lastValidBlockHeight: 100, stage: 'wallet-pending', signature: null });
const state = () => ({
  machine: { publicKey: S.machine, collectionMint: S.collection, mintAuthority: S.guard, data: { itemsAvailable: 2n }, itemsLoaded: 2, itemsRedeemed: 1n },
  guard: { publicKey: S.guard, authority: S.laboratory, groups: [], guards: {
    addressGate: { __option: 'Some', value: { address: S.owner } },
    solPayment: { __option: 'Some', value: { lamports: { basisPoints: S.price }, destination: S.owner } },
  } },
  collection: { publicKey: S.collection, updateAuthority: S.laboratory, royalties: { basisPoints: 700, creators: [{ address: S.owner, percentage: 100 }] } },
});
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };

test('browser transport cannot submit or change RPC, and does not retry 429', async () => {
  let calls = 0;
  const fetch = makeReadFetch(async () => { calls++; return new Response('{}', { status: 429 }); });
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'sendTransaction' }) }), /Read-only/);
  await assert.rejects(fetch('https://api.mainnet-beta.solana.com', { body: '{}' }), /Unexpected/);
  assert.equal(calls, 0);
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'getGenesisHash' }) }), /429/);
  assert.equal(calls, 1);
});
test('unresponsive RPC and wallet calls return bounded errors', async () => {
  const fetch = makeReadFetch((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('abort')))), 8);
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'getGenesisHash' }) }), /RPC/);
  await assert.rejects(boundedWalletCall(new Promise(() => {}), 8), /Кошелёк/);
});
test('changed price, treasury, royalty and hidden extra guards stop signing', () => {
  assert.doesNotThrow(() => assertState(state()));
  for (const mutate of [
    x => x.guard.guards.solPayment.value.lamports.basisPoints = 1n,
    x => x.guard.guards.solPayment.value.destination = S.laboratory,
    x => x.collection.royalties.basisPoints = 800,
    x => x.guard.guards.botTax = { __option: 'Some', value: {} },
    x => x.guard.guards.addressGate.value.address = S.laboratory,
  ]) { const current = state(); mutate(current); assert.throws(() => assertState(current)); }
});
test('NFT verification rejects wrong owner, collection and arbitrary metadata', () => {
  const asset = { owner: S.owner, updateAuthority: { type: 'Collection', address: S.collection }, name: 'CoolBears #0001 — Hidden Bear', uri: 'https://coolbears-nfts.com/metadata/hidden/0001.json' };
  assert.doesNotThrow(() => assertAsset(asset));
  assert.throws(() => assertAsset({ ...asset, owner: S.laboratory }));
  assert.throws(() => assertAsset({ ...asset, updateAuthority: { type: 'Address', address: S.collection } }));
  assert.throws(() => assertAsset({ ...asset, uri: 'https://other.example/metadata/hidden/0001.json' }));
});
test('pending and completed operations survive reload and prevent duplicate prompts', () => {
  const store = storage(); saveOperation(store, op());
  assert.equal(mayStart(readOperation(store)), false);
  for (const stage of ['submitted', 'unknown', 'verified']) assert.equal(mayStart({ ...op(), stage }), false);
  for (const stage of ['cancelled', 'failed', 'expired']) assert.equal(mayStart({ ...op(), stage }), true);
  assert.throws(() => saveOperation({ setItem() {}, getItem() { return null; } }, op()), /не сохранил/);
  store.setItem(S.storageKey, '{}'); assert.throws(() => readOperation(store));
});
test('another tab cannot enter the mint critical section', async () => {
  let entered = false;
  await assert.rejects(withMintLock({ request: async (_key, _options, run) => run(null) }, () => { entered = true; }), /другой вкладке/);
  assert.equal(entered, false);
});

function recovery({ status = null, valid = true, height = 101, history = [] } = {}) {
  const calls = [];
  return { calls, umi: { rpc: { getAccount: async () => ({ exists: false }) } }, async rpc(method) {
    calls.push(method);
    switch (method) {
      case 'getGenesisHash': return S.genesis;
      case 'getSignaturesForAddress': return history;
      case 'getSignatureStatuses': return { context: { slot: 150 }, value: [status] };
      case 'isBlockhashValid': return { context: { slot: 150 }, value: valid };
      case 'getAccountInfo': return { context: { slot: 150 }, value: null };
      case 'getBlockHeight': return height;
      default: throw Error('Unexpected write or RPC: ' + method);
    }
  } };
}
test('unknown wallet result cannot become a new mint until expiry AND absence are proved', async () => {
  assert.equal((await inspectOperation(recovery(), op())).stage, 'unknown');
  assert.equal((await inspectOperation(recovery({ valid: false, height: 99 }), op())).stage, 'unknown');
  const client = recovery({ valid: false });
  assert.equal((await inspectOperation(client, op())).stage, 'expired');
  assert.ok(client.calls.every(method => !method.startsWith('send')));
});
test('a late NFT or stale RPC snapshot prevents an expiry retry', async () => {
  for (const account of [{ context: { slot: 150 }, value: {} }, { context: { slot: 149 }, value: null }]) {
    const client = recovery({ valid: false });
    const rpc = client.rpc;
    client.rpc = function(method, params) { return method === 'getAccountInfo' ? Promise.resolve(account) : rpc.call(this, method, params); };
    if (account.value) assert.equal((await inspectOperation(client, op())).stage, 'unknown');
    else await assert.rejects(inspectOperation(client, op()), /устаревшее/);
  }
});
test('positive slot or finalized status without an NFT is never mint success', async () => {
  const saved = { ...op(), signature: '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7' };
  const failed = { slot: 123, confirmationStatus: 'finalized', err: { InstructionError: [1, 'error'] } };
  assert.equal((await inspectOperation(recovery({ status: failed }), saved)).stage, 'failed');
  assert.equal((await inspectOperation(recovery({ status: { ...failed, err: null } }), saved)).stage, 'unknown');
});

test('browser builder parses real account fixtures and signs only the generated asset', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
  const methods = [];
  const client = createClient(async (_url, options) => {
    const request = JSON.parse(options.body); methods.push(request.method);
    const result = request.method === 'simulateTransaction' ? { value: { err: null, logs: [] } } : fixtures[request.method];
    assert.notEqual(result, undefined, request.method);
    return new Response(JSON.stringify({ id: request.id, jsonrpc: '2.0', result }));
  });
  const prepared = await prepareMint(client, S.owner);
  const tx = VersionedTransaction.deserialize(prepared.bytes);
  assert.equal(tx.version, 0);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), S.owner);
  assert.equal(tx.signatures[0].some(byte => byte !== 0), false);
  const assetIndex = tx.message.staticAccountKeys.findIndex(key => key.toBase58() === prepared.operation.asset);
  assert.ok(assetIndex > 0);
  assert.ok(tx.signatures[assetIndex].some(byte => byte !== 0));
  assert.ok(client.umi.eddsa.verify(tx.message.serialize(), tx.signatures[assetIndex], prepared.operation.asset));
  assert.ok(!methods.includes('sendTransaction'));
});

test('finalized recovery decodes a Core asset and verifies its owner and metadata', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
  const asset = JSON.parse(await readFile(new URL('./fixtures/devnet-existing-asset.json', import.meta.url), 'utf8'));
  const saved = { ...op(), signature: '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7' };
  const client = createClient(async (_url, options) => {
    const request = JSON.parse(options.body);
    const result = request.method === 'getAccountInfo' ? asset : request.method === 'getSignatureStatuses' ? { value: [{ confirmationStatus: 'finalized', err: null, slot: 502070178 }] } : fixtures[request.method];
    assert.notEqual(result, undefined, request.method);
    return new Response(JSON.stringify({ id: request.id, jsonrpc: '2.0', result }));
  });
  const result = await inspectOperation(client, saved);
  assert.equal(result.stage, 'verified');
  assert.equal(result.name, 'CoolBears #0002 — Hidden Bear');
});

test('Wallet Standard explicitly submits to solana:devnet and detects an account switch', async () => {
  const account = { address: S.owner, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
  let sent = 0;
  const standard = { name: 'Phantom', version: '1.0.0', icon: 'data:image/svg+xml;base64,', chains: ['solana:devnet'], accounts: [account], features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'standard:events': { version: '1.0.0', on: () => () => {} },
    'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: [0], async signAndSendTransaction(input) {
      sent++; assert.equal(input.chain, 'solana:devnet'); assert.equal(input.account, account);
      assert.equal(input.options.skipPreflight, false); assert.equal(input.options.preflightCommitment, 'confirmed');
      return [{ signature: new Uint8Array(64).fill(8) }];
    } },
  } };
  const unregister = getWallets().register(standard);
  try {
    const wallet = await connectWallet('Phantom', () => {}, {});
    assert.equal(wallet.address, S.owner);
    await wallet.send(new Uint8Array([1, 2, 3]));
    standard.accounts = [];
    await assert.rejects(wallet.send(new Uint8Array([1])), /сменил аккаунт/);
    assert.equal(sent, 1); wallet.off();
  } finally { unregister(); }
});
