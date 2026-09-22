import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReadFetch } from '../devnet/rpc.mjs';
import { settings as S } from '../devnet/settings.mjs';
import { getWalletOptions, phantomBrowseUrl, solflareBrowseUrl, backpackBrowseUrl } from '../wallet-core.mjs';

test('successful RPC reads are paced and cannot create an immediate burst', async () => {
  const times = [];
  const read = makeReadFetch(async (_url, options) => {
    times.push(Date.now()); return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: S.genesis }));
  }, { minIntervalMs: 35, totalTimeoutMs: 1000 });
  const request = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }) };
  await Promise.all([read(S.rpc, request), read(S.rpc, request), read(S.rpc, request)]);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 30 && times[2] - times[1] >= 30);
});

test('wallet browse URLs keep only an approved wallet hint and strip private URL components', () => {
  for (const browse of [phantomBrowseUrl, solflareBrowseUrl, backpackBrowseUrl]) {
    const link = decodeURIComponent(browse('https://user:secret@coolbears-nfts.com/?rpc=secret&connectWallet=Backpack#secret'));
    assert.ok(!link.includes('secret') && !link.includes('user:'));
    assert.ok(link.includes('https://coolbears-nfts.com/?connectWallet=Backpack'));
    assert.throws(() => browse('http://example.com'), /HTTPS/);
  }
  const options = getWalletOptions({}, 'https://coolbears-nfts.com/', true);
  assert.deepEqual(options.map(option => option.name), ['Phantom', 'Solflare', 'Backpack']);
  assert.ok(options.every(option => option.opensApp));
});

// Additional sign-only protocol tests use in-memory providers and no network.
import { getWallets } from '@wallet-standard/app';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { hasPhantomSigner, connectPhantomSigner, connectWallet, getAvailableWallets } from '../devnet/wallet.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function transaction(version = 0) {
  const message = new TransactionMessage({ payerKey: new PublicKey(S.owner), recentBlockhash: '11111111111111111111111111111111', instructions: [] });
  return new VersionedTransaction(version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
}
function fixture() {
  const listeners = new Map();
  const calls = { connects: 0, signs: [], sends: 0 };
  const provider = {
    publicKey: new PublicKey(S.owner),
    async connect() { calls.connects++; return { publicKey: provider.publicKey }; },
    on(event, handler) { const handlers = listeners.get(event) || new Set(); handlers.add(handler); listeners.set(event, handlers); },
    removeListener(event, handler) { listeners.get(event)?.delete(handler); },
    async signTransaction(value) { calls.signs.push(value); value.signatures[0].fill(9); return value; },
    async signAndSendTransaction() { calls.sends++; throw Error('Sign-only route must never send'); },
  };
  return {
    provider, scope: { phantom: { solana: provider } }, calls,
    emit(event) { for (const handler of [...listeners.get(event) || []]) handler(); },
    count() { return [...listeners.values()].reduce((count, handlers) => count + handlers.size, 0); },
  };
}

test('sign-only availability checks callable connect/sign/events/cleanup without connecting', () => {
  const valid = fixture(); assert.equal(hasPhantomSigner(valid.scope), true); assert.equal(valid.calls.connects, 0);
  for (const missing of ['connect', 'signTransaction', 'on', 'removeListener']) {
    const value = fixture(); value.provider[missing] = true;
    assert.equal(hasPhantomSigner(value.scope), false, missing);
  }
  valid.provider.off = valid.provider.removeListener; delete valid.provider.removeListener;
  assert.equal(hasPhantomSigner(valid.scope), true);
  assert.equal(hasPhantomSigner({ solana: valid.provider }), false);
  assert.equal(hasPhantomSigner({}), false);
});

test('missing sign-only capability rejects before any connect or sending', async () => {
  for (const missing of ['connect', 'signTransaction', 'on', 'removeListener']) {
    const value = fixture(); delete value.provider[missing];
    await assert.rejects(connectPhantomSigner(undefined, value.scope), /отдельную подпись/);
    assert.equal(value.calls.connects, 0); assert.equal(value.calls.sends, 0); assert.equal(value.count(), 0);
  }
});

test('explicit sign-only session returns v0 bytes without altering input or calling signAndSend', async t => {
  const value = fixture(); const session = await connectPhantomSigner(undefined, value.scope); t.after(session.off);
  assert.deepEqual({ id: session.id, name: session.name, transport: session.transport, route: session.route, address: session.address }, {
    id: 'injected:phantom:sign-only', name: 'Phantom', transport: 'injected', route: 'custom-rpc', address: S.owner,
  });
  assert.equal('send' in session, false); assert.equal(value.calls.signs.length, 0); assert.equal(value.calls.sends, 0);
  const original = transaction().serialize(); const before = new Uint8Array(original);
  const signed = await session.sign(original);
  assert.ok(signed instanceof Uint8Array); assert.equal(VersionedTransaction.deserialize(signed).version, 0);
  assert.deepEqual(VersionedTransaction.deserialize(signed).signatures[0], new Uint8Array(64).fill(9));
  assert.deepEqual(original, before); assert.equal(value.calls.signs.length, 1); assert.equal(value.calls.sends, 0);
});

test('Wallet Standard remains default even when the explicit sign-only provider exists', async t => {
  const value = fixture(); let standardConnects = 0;
  const account = { address: S.owner, publicKey: new PublicKey(S.owner).toBytes(), chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
  const wallet = { name: 'Phantom', version: '1.0.0', chains: ['solana:devnet'], accounts: [account], features: {
    'standard:connect': { async connect() { standardConnects++; return { accounts: [account] }; } },
    'standard:events': { on() { return () => {}; } },
    'solana:signAndSendTransaction': { supportedTransactionVersions: [0], async signAndSendTransaction() { throw Error('No signing in connect'); } },
  } };
  const unregister = getWallets().register(wallet); t.after(unregister);
  const options = getAvailableWallets(value.scope);
  assert.equal(options.length, 1); assert.equal(options[0].kind, 'standard');
  const normal = await connectWallet('Phantom', undefined, value.scope); t.after(normal.off);
  assert.equal(standardConnects, 1); assert.equal(value.calls.connects, 0); assert.equal('sign' in normal, false);
  const explicit = await connectPhantomSigner(undefined, value.scope); t.after(explicit.off);
  assert.equal(value.calls.connects, 1); assert.equal(standardConnects, 1); assert.equal('send' in explicit, false);
  assert.equal(value.calls.sends, 0);
});

test('connect rejection preserves 4001 and leaves no listeners', async () => {
  const value = fixture(); const rejection = Object.assign(Error('User rejected'), { code: 4001 });
  value.provider.connect = async () => { throw rejection; };
  await assert.rejects(connectPhantomSigner(undefined, value.scope), error => error === rejection);
  assert.equal(value.count(), 0); assert.equal(value.calls.sends, 0);
});

test('connect timeout and abort ignore late approvals with no listener leaks', async () => {
  const value = fixture(); const waiting = deferred(); value.provider.connect = () => waiting.promise;
  await assert.rejects(connectPhantomSigner(undefined, value.scope, { timeoutMs: 5 }), /вовремя/);
  waiting.resolve({ publicKey: value.provider.publicKey }); await tick(); assert.equal(value.count(), 0);
  const second = fixture(); const delayed = deferred(); second.provider.connect = () => delayed.promise;
  const controller = new AbortController(); const pending = connectPhantomSigner(undefined, second.scope, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  delayed.resolve({ publicKey: second.provider.publicKey }); await tick(); assert.equal(second.count(), 0);
  const third = fixture();
  await assert.rejects(connectPhantomSigner(undefined, third.scope, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(third.calls.connects, 0);
});

test('invalid address or account/provider replacement during connect cannot create a session', async () => {
  const value = fixture(); value.provider.publicKey = { toString: () => 'not-a-key' };
  await assert.rejects(connectPhantomSigner(undefined, value.scope), /адрес/);
  value.provider.publicKey = new PublicKey(S.owner);
  value.provider.connect = async () => ({ publicKey: new PublicKey(S.laboratory) });
  await assert.rejects(connectPhantomSigner(undefined, value.scope), /сменил аккаунт/);
  const changed = fixture(); const waiting = deferred(); changed.provider.connect = () => waiting.promise;
  const pending = connectPhantomSigner(undefined, changed.scope); changed.scope.phantom.solana = fixture().provider;
  waiting.resolve({ publicKey: changed.provider.publicKey });
  await assert.rejects(pending, /Phantom изменился/); assert.equal(changed.count(), 0);
});

test('account changes, disconnect and off invalidate once and prohibit further signing', async () => {
  for (const event of ['accountChanged', 'disconnect']) {
    const value = fixture(); let changes = 0;
    const session = await connectPhantomSigner(() => changes++, value.scope);
    assert.equal(value.count(), 2); value.emit(event); value.emit(event); session.off();
    assert.equal(changes, 1); assert.equal(value.count(), 0);
    await assert.rejects(session.sign(transaction().serialize()), /сменил аккаунт/);
    assert.equal(value.calls.signs.length, 0); assert.equal(value.calls.sends, 0);
  }
  const value = fixture(); value.provider.off = value.provider.removeListener; delete value.provider.removeListener;
  const session = await connectPhantomSigner(undefined, value.scope); session.off(); session.off(); assert.equal(value.count(), 0);
  await assert.rejects(session.sign(transaction().serialize()), /сменил аккаунт/);
});

test('silent account, capability and provider changes are checked before signTransaction', async t => {
  for (const change of [
    value => { value.provider.publicKey = new PublicKey(S.laboratory); },
    value => { delete value.provider.signTransaction; },
    value => { value.scope.phantom.solana = fixture().provider; },
  ]) {
    const value = fixture(); const session = await connectPhantomSigner(undefined, value.scope); t.after(session.off); change(value);
    await assert.rejects(session.sign(transaction().serialize()), /сменил аккаунт/); assert.equal(value.calls.signs.length, 0);
  }
});

test('late signed response survives invalidation for archival but never submits or restores the session', async () => {
  const value = fixture(); const waiting = deferred(); value.provider.signTransaction = () => waiting.promise;
  const session = await connectPhantomSigner(undefined, value.scope);
  const pending = session.sign(transaction().serialize()); value.emit('disconnect');
  const response = transaction(); response.signatures[0].fill(7); waiting.resolve(response);
  const signed = await pending; assert.deepEqual(VersionedTransaction.deserialize(signed).signatures[0], new Uint8Array(64).fill(7));
  assert.equal(value.count(), 0); assert.equal(value.calls.sends, 0);
  await assert.rejects(session.sign(transaction().serialize()), /сменил аккаунт/);
});

test('sign cancellation preserves 4001 and never falls back to signAndSend', async t => {
  const value = fixture(); const session = await connectPhantomSigner(undefined, value.scope); t.after(session.off);
  const rejection = Object.assign(Error('User rejected'), { code: 4001 }); value.provider.signTransaction = async () => { throw rejection; };
  await assert.rejects(session.sign(transaction().serialize()), error => error === rejection); assert.equal(value.calls.sends, 0);
});

test('malformed/legacy input cannot prompt; malformed or legacy result is rejected', async t => {
  const value = fixture(); const session = await connectPhantomSigner(undefined, value.scope); t.after(session.off);
  for (const input of [[1, 2], new Uint8Array([1]), transaction('legacy').serialize()]) await assert.rejects(session.sign(input));
  assert.equal(value.calls.signs.length, 0);
  for (const output of [undefined, {}, transaction('legacy'), { version: 0, serialize: () => [1, 2] }, { version: 0, serialize: () => new Uint8Array([1]) }, { version: 0, serialize: () => transaction('legacy').serialize() }]) {
    value.provider.signTransaction = async () => output;
    await assert.rejects(session.sign(transaction().serialize()));
  }
  assert.equal(value.calls.sends, 0);
});

test('unsigned v0 output remains untrusted bytes for the separate full-signature validator', async t => {
  const value = fixture(); value.provider.signTransaction = async input => input;
  const session = await connectPhantomSigner(undefined, value.scope); t.after(session.off);
  const unsigned = await session.sign(transaction().serialize());
  assert.equal(VersionedTransaction.deserialize(unsigned).signatures[0].some(Boolean), false);
  assert.equal(value.calls.sends, 0); assert.equal('send' in session, false);
});
