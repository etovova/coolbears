import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
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

test('browser transport cannot submit or change RPC, and supports explicit single-attempt checks', async () => {
  let calls = 0;
  const fetch = makeReadFetch(async () => { calls++; return new Response('{}', { status: 429 }); }, { maxAttempts: 1 });
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'sendTransaction' }) }), /Read-only/);
  await assert.rejects(fetch('https://api.mainnet-beta.solana.com', { body: '{}' }), /Unexpected/);
  assert.equal(calls, 0);
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'getGenesisHash' }) }), /429/);
  assert.equal(calls, 1);
});
test('unresponsive RPC and wallet calls return bounded errors', async () => {
  const fetch = makeReadFetch((_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('abort')))), 8);
  await assert.rejects(fetch(S.rpc, { body: JSON.stringify({ method: 'getGenesisHash' }) }), /RPC/);
  await assert.rejects(boundedWalletCall(new Promise(() => {}), 8), { code: 'WALLET_TIMEOUT' });
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
    const result = request.method === 'simulateTransaction' ? { value: { err: null, logs: [] } } : request.method === 'getBlockHeight' ? fixtures.getLatestBlockhash.value.lastValidBlockHeight - 140 : fixtures[request.method];
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
  assert.equal(prepared.operation.preparation.remainingBlocks, 140);
  assert.equal(prepared.operation.preparation.attempt, 1);
  assert.ok(!methods.includes('sendTransaction'));
});

async function preparationFixture({ remaining = () => 140, advance = () => {}, simulationError = null } = {}) {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
  const calls = [], simulations = [];
  const hashes = [fixtures.getLatestBlockhash.value.blockhash, S.machine];
  let passes = 0;
  const client = createClient(async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    let result = fixtures[request.method];
    if (request.method === 'getLatestBlockhash') {
      passes++;
      result = { ...fixtures.getLatestBlockhash, value: { ...fixtures.getLatestBlockhash.value, blockhash: hashes[passes - 1] } };
    }
    if (request.method === 'simulateTransaction') {
      simulations.push(new Uint8Array(Buffer.from(request.params[0], 'base64')));
      result = { value: { err: simulationError, logs: [] } };
    }
    if (request.method === 'getBlockHeight') result = fixtures.getLatestBlockhash.value.lastValidBlockHeight - remaining(passes);
    advance(request.method, passes);
    assert.notEqual(result, undefined, request.method);
    return new Response(JSON.stringify({ id: request.id, jsonrpc: '2.0', result }));
  }, { minIntervalMs: 0 });
  return { client, calls, simulations, get passes() { return passes; } };
}

test('preparation refreshes a stale hash once, retains its asset and returns exactly simulated bytes', async () => {
  const fixture = await preparationFixture({ remaining: pass => pass === 1 ? 99 : 140 });
  const prepared = await prepareMint(fixture.client, S.owner);
  assert.equal(fixture.passes, 2);
  assert.equal(fixture.simulations.length, 2);
  assert.deepEqual(prepared.bytes, fixture.simulations[1]);
  const transactions = fixture.simulations.map(bytes => VersionedTransaction.deserialize(bytes));
  assert.notEqual(transactions[0].message.recentBlockhash, transactions[1].message.recentBlockhash);
  for (const tx of transactions) {
    const assetIndex = tx.message.staticAccountKeys.findIndex(key => key.toBase58() === prepared.operation.asset);
    assert.ok(assetIndex > 0, 'Both passes retain the same generated asset');
    assert.equal(tx.signatures[0].some(Boolean), false, 'The wallet owner has not signed');
    assert.ok(fixture.client.umi.eddsa.verify(tx.message.serialize(), tx.signatures[assetIndex], prepared.operation.asset));
  }
  assert.equal(prepared.operation.preparation.attempt, 2);
  assert.equal(prepared.operation.preparation.remainingBlocks, 140);
  assert.ok(fixture.calls.filter(call => call.method === 'getBlockHeight').every(call => call.params[0].commitment === 'confirmed'));
  assert.ok(fixture.calls.every(call => !call.method.startsWith('send')));
});

test('preparation accepts the inclusive 100-block and 15000ms boundaries', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const fixture = await preparationFixture({ remaining: () => 100, advance: method => { if (method === 'getBlockHeight') clock += 15000; } });
  const prepared = await prepareMint(fixture.client, S.owner);
  assert.equal(fixture.passes, 1);
  assert.deepEqual(prepared.bytes, fixture.simulations[0]);
  assert.equal(prepared.operation.preparation.elapsedMs, 15000);
  assert.equal(prepared.operation.preparation.remainingBlocks, 100);
  assert.ok(Number.isFinite(Date.parse(prepared.operation.preparation.startedAt)));
  assert.ok(Number.isFinite(Date.parse(prepared.operation.preparation.readyAt)));
});

test('slow blockhash, simulation or final height response refreshes preparation before returning', async t => {
  for (const delayed of ['getLatestBlockhash', 'simulateTransaction', 'getBlockHeight']) {
    await t.test(delayed, async t => {
      let clock = 0;
      t.mock.method(performance, 'now', () => clock);
      const fixture = await preparationFixture({ advance: (method, pass) => { if (method === delayed && pass === 1) clock += 15001; } });
      const prepared = await prepareMint(fixture.client, S.owner);
      assert.equal(fixture.passes, 2);
      assert.equal(prepared.operation.preparation.attempt, 2);
      assert.equal(prepared.operation.preparation.elapsedMs, 0);
      assert.deepEqual(prepared.bytes, fixture.simulations[1]);
    });
  }
});

test('two stale or slow preparation passes stop without returning signing bytes', async t => {
  for (const mode of ['stale', 'slow']) {
    await t.test(mode, async t => {
      let clock = 0;
      t.mock.method(performance, 'now', () => clock);
      const fixture = await preparationFixture({ remaining: () => mode === 'stale' ? 99 : 140, advance: method => { if (mode === 'slow' && method === 'getBlockHeight') clock += 15001; } });
      await assert.rejects(prepareMint(fixture.client, S.owner), { code: 'PREPARATION_STALE' });
      assert.equal(fixture.passes, 2);
      assert.equal(fixture.simulations.length, 2);
      assert.ok(fixture.calls.every(call => !call.method.startsWith('send')));
    });
  }
});

test('malformed current or expiry height stops preparation before it can reach a wallet', async () => {
  for (const height of [null, '123', 1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = await preparationFixture();
    const rpc = fixture.client.rpc;
    fixture.client.rpc = (method, params) => method === 'getBlockHeight' ? Promise.resolve(height) : rpc(method, params);
    await assert.rejects(prepareMint(fixture.client, S.owner), /некорректную высоту/);
    assert.equal(fixture.passes, 1);
  }
  for (const height of [null, '123', 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = await preparationFixture();
    const latest = await fixture.client.umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    fixture.client.umi.rpc.getLatestBlockhash = async () => ({ ...latest, lastValidBlockHeight: height });
    await assert.rejects(prepareMint(fixture.client, S.owner), /некорректный срок/);
    assert.equal(fixture.simulations.length, 0);
  }
});

test('a simulation failure is not retried as freshness trouble', async () => {
  const fixture = await preparationFixture({ simulationError: { InstructionError: [1, { Custom: 6033 }] } });
  await assert.rejects(prepareMint(fixture.client, S.owner), /Симуляция минта/);
  assert.equal(fixture.passes, 1);
  assert.equal(fixture.simulations.length, 1);
  assert.equal(fixture.calls.some(call => call.method === 'getBlockHeight'), false);
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
  const account = { address: S.owner, publicKey: new PublicKey(S.owner).toBytes(), chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
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
