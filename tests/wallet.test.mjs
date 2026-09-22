// Protocol tests with in-memory Wallet Standard / injected providers.
// These do not represent a physical wallet, device or real transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWallets } from '@wallet-standard/app';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { connectWallet, getAvailableWallets, subscribeWallets, walletConnectionAction } from '../devnet/wallet.mjs';
import { settings as S } from '../devnet/settings.mjs';

const CHAIN = 'solana:devnet';
const SEND = 'solana:signAndSendTransaction';
const signatureBytes = new Uint8Array(64).fill(37);
const signature = base58.deserialize(signatureBytes)[0];
const registry = getWallets();
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const account = (address = S.owner, chains = [CHAIN]) => ({ address, publicKey: base58.serialize(address), chains, features: [SEND] });
function makeStandard(t, name = 'Protocol Test Wallet') {
  const listeners = new Set();
  const calls = { connects: 0, sends: [] };
  const wallet = {
    name, version: '1.0.0', icon: 'data:image/svg+xml,<svg/>', chains: [CHAIN], accounts: [account()],
    features: {
      'standard:connect': { version: '1.0.0', async connect() { calls.connects++; return { accounts: wallet.accounts }; } },
      'standard:events': { version: '1.0.0', on(event, callback) { assert.equal(event, 'change'); listeners.add(callback); return () => listeners.delete(callback); } },
      [SEND]: { version: '1.0.0', supportedTransactionVersions: [0], async signAndSendTransaction(input) { calls.sends.push(input); return [{ signature: signatureBytes }]; } },
    },
  };
  const unregister = registry.register(wallet); t.after(unregister);
  return { wallet, calls, listeners, unregister, emit(properties) { for (const listener of [...listeners]) listener(properties); } };
}
function makeInjected(name = 'Phantom') {
  const listeners = new Map();
  const calls = { connects: 0, sends: [] };
  const provider = {
    publicKey: { toString: () => S.owner },
    async connect() { calls.connects++; return { publicKey: provider.publicKey }; },
    on(event, callback) { const handlers = listeners.get(event) || new Set(); handlers.add(callback); listeners.set(event, handlers); },
    removeListener(event, callback) { listeners.get(event)?.delete(callback); },
    async signAndSendTransaction(transaction, options) { calls.sends.push({ transaction, options }); return { signature }; },
  };
  const scope = name === 'Phantom' ? { phantom: { solana: provider } } : { solflare: provider };
  return { provider, scope, calls, listeners, emit(event) { for (const listener of [...listeners.get(event) || []]) listener(); } };
}
function bytes() {
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(S.owner), recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message()).serialize();
}

test('discovery requires Devnet, v0, connect, events and signAndSend, without a brand allowlist', t => {
  const good = makeStandard(t, 'Backpack');
  const mainnet = makeStandard(t, 'Mainnet only'); mainnet.wallet.chains = ['solana:mainnet'];
  const legacy = makeStandard(t, 'Legacy only'); legacy.wallet.features[SEND].supportedTransactionVersions = ['legacy'];
  const events = makeStandard(t, 'No events'); delete events.wallet.features['standard:events'];
  const sender = makeStandard(t, 'No send'); delete sender.wallet.features[SEND].signAndSendTransaction;
  assert.deepEqual(getAvailableWallets({}).map(({ name }) => name), ['Backpack']);
  assert.equal(good.calls.connects, 0); assert.equal(good.calls.sends.length, 0);
});

test('standard preferred over same-name injected provider; duplicate standard names use exact IDs', async t => {
  const first = makeStandard(t, 'Phantom'); const second = makeStandard(t, 'Phantom');
  const fallback = makeInjected();
  const choices = getAvailableWallets(fallback.scope);
  assert.equal(choices.length, 2); assert.notEqual(choices[0].id, choices[1].id);
  await assert.rejects(connectWallet('Phantom', undefined, fallback.scope), /несколько/);
  const session = await connectWallet(choices[1].id, undefined, fallback.scope); t.after(session.off);
  assert.equal(first.calls.connects, 0); assert.equal(second.calls.connects, 1); assert.equal(fallback.calls.connects, 0);
});

test('standard sends exactly selected account, Devnet, v0 bytes and preflight; connects never sign', async t => {
  const fixture = makeStandard(t); const session = await connectWallet('Protocol Test Wallet'); t.after(session.off);
  assert.equal(session.name, fixture.wallet.name); assert.equal(session.address, S.owner); assert.equal(fixture.calls.sends.length, 0);
  const transaction = bytes(); assert.equal(await session.send(transaction), signature);
  assert.deepEqual(fixture.calls.sends, [{ account: fixture.wallet.accounts[0], chain: CHAIN, transaction, options: { preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5 } }]);
});

test('account chains/features/key must match Devnet and actual public address', async t => {
  const fixture = makeStandard(t);
  fixture.wallet.accounts = [account(S.owner, ['solana:mainnet'])];
  await assert.rejects(connectWallet(fixture.wallet.name), /Devnet/);
  fixture.wallet.accounts = [{ ...account(), features: [] }];
  await assert.rejects(connectWallet(fixture.wallet.name), /Devnet/);
  fixture.wallet.accounts = [{ ...account(), publicKey: new Uint8Array(32) }];
  await assert.rejects(connectWallet(fixture.wallet.name), /Devnet/);
  assert.equal(fixture.listeners.size, 0); assert.equal(fixture.calls.sends.length, 0);
});

test('changed account or removed capabilities invalidates once and prevents send', async t => {
  for (const property of ['accounts', 'features', 'chains']) {
    const fixture = makeStandard(t, property); let changes = 0;
    const session = await connectWallet(property, () => changes++); t.after(session.off);
    fixture.emit({ [property]: [] }); fixture.emit({ [property]: [] });
    assert.equal(changes, 1); assert.equal(fixture.listeners.size, 0);
    await assert.rejects(session.send(bytes()), /изменился/); assert.equal(fixture.calls.sends.length, 0);
  }
});

test('silent account or capability changes are checked again before signing', async t => {
  const fixture = makeStandard(t); const session = await connectWallet(fixture.wallet.name); t.after(session.off);
  fixture.wallet.accounts = [account(S.laboratory)];
  await assert.rejects(session.send(bytes()), /сменил аккаунт/);
  fixture.wallet.accounts = [account()]; fixture.wallet.features[SEND].supportedTransactionVersions = ['legacy'];
  await assert.rejects(session.send(bytes()), /изменился/);
  assert.equal(fixture.calls.sends.length, 0);
});

test('off and registry unregister invalidate sessions and release listeners', async t => {
  const fixture = makeStandard(t); let changes = 0;
  let session = await connectWallet(fixture.wallet.name, () => changes++);
  session.off(); session.off(); assert.equal(fixture.listeners.size, 0);
  await assert.rejects(session.send(bytes()), /изменился/);
  session = await connectWallet(fixture.wallet.name, () => changes++); fixture.unregister();
  assert.equal(changes, 1); assert.equal(fixture.listeners.size, 0);
  await assert.rejects(session.send(bytes()), /изменился/);
});

test('explicit rejection preserves code 4001; malformed returned signature is not accepted', async t => {
  const fixture = makeStandard(t); const session = await connectWallet(fixture.wallet.name); t.after(session.off);
  const rejected = Object.assign(new Error('User rejected'), { code: 4001 });
  fixture.wallet.features[SEND].signAndSendTransaction = async () => { throw rejected; };
  await assert.rejects(session.send(bytes()), error => error === rejected);
  for (const value of [new Uint8Array(63), new Uint8Array(64), undefined, signature]) {
    fixture.wallet.features[SEND].signAndSendTransaction = async () => [{ signature: value }];
    await assert.rejects(session.send(bytes()), /подпись/);
  }
});

test('connect timeout rejects and a late approval creates no active listeners or callback', async t => {
  const fixture = makeStandard(t); const delayed = deferred(); let changes = 0;
  fixture.wallet.features['standard:connect'].connect = () => delayed.promise;
  await assert.rejects(connectWallet(fixture.wallet.name, () => changes++, {}, { timeoutMs: 5 }), /вовремя/);
  delayed.resolve({ accounts: fixture.wallet.accounts }); await tick(); fixture.emit({ accounts: [] });
  assert.equal(fixture.listeners.size, 0); assert.equal(changes, 0); assert.equal(fixture.calls.sends.length, 0);
});

test('abort before connect opens no prompt; abort during connect ignores late approval', async t => {
  const fixture = makeStandard(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(connectWallet(fixture.wallet.name, undefined, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fixture.calls.connects, 0);
  const delayed = deferred(); fixture.wallet.features['standard:connect'].connect = () => delayed.promise;
  const active = new AbortController(); const pending = connectWallet(fixture.wallet.name, undefined, {}, { signal: active.signal }); active.abort();
  await assert.rejects(pending, { name: 'AbortError' }); delayed.resolve({ accounts: fixture.wallet.accounts }); await tick();
  assert.equal(fixture.listeners.size, 0);
});

test('unregister or stale connect result while approval is pending cannot create a session', async t => {
  const fixture = makeStandard(t); const delayed = deferred(); fixture.wallet.features['standard:connect'].connect = () => delayed.promise;
  const pending = connectWallet(fixture.wallet.name); fixture.unregister(); delayed.resolve({ accounts: fixture.wallet.accounts });
  await assert.rejects(pending, /недоступен/); assert.equal(fixture.listeners.size, 0);
  const stale = makeStandard(t, 'Stale'); const original = stale.wallet.accounts;
  stale.wallet.features['standard:connect'].connect = async () => { stale.wallet.accounts = [account(S.laboratory)]; return { accounts: original }; };
  await assert.rejects(connectWallet(stale.wallet.name), /сменил аккаунт/); assert.equal(stale.listeners.size, 0);
});

test('discovery notices late registration, capability changes and unregister, then stops cleanly', t => {
  let events = 0; const stop = subscribeWallets(() => events++); assert.equal(events, 1);
  const fixture = makeStandard(t); assert.equal(events, 2); assert.equal(fixture.listeners.size, 1);
  fixture.wallet.chains = ['solana:mainnet']; fixture.emit({ chains: fixture.wallet.chains }); assert.equal(events, 3);
  assert.equal(getAvailableWallets({}).length, 0);
  fixture.unregister(); assert.equal(events, 4); assert.equal(fixture.listeners.size, 0);
  stop(); stop(); makeStandard(t, 'After stop'); assert.equal(events, 4);
});

test('late signature remains available after wallet change during an already-started send', async t => {
  const fixture = makeStandard(t); const delayed = deferred(); fixture.wallet.features[SEND].signAndSendTransaction = () => delayed.promise;
  let changes = 0; const session = await connectWallet(fixture.wallet.name, () => changes++); t.after(session.off);
  const pending = session.send(bytes()); fixture.emit({ accounts: [] }); delayed.resolve([{ signature: signatureBytes }]);
  assert.equal(await pending, signature); assert.equal(changes, 1);
});

test('injected Phantom and Solflare preserve v0 and disable session on account/disconnect changes', async () => {
  for (const name of ['Phantom', 'Solflare']) {
    const fixture = makeInjected(name); let changes = 0;
    const session = await connectWallet(name, () => changes++, fixture.scope);
    assert.equal(await session.send(bytes()), signature); assert.equal(fixture.calls.sends[0].transaction.version, 0);
    assert.deepEqual(fixture.calls.sends[0].options, { preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5 });
    fixture.emit(name === 'Phantom' ? 'accountChanged' : 'disconnect'); assert.equal(changes, 1);
    assert.equal([...fixture.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0), 0);
    await assert.rejects(session.send(bytes()), /сменил аккаунт/);
  }
});

test('injected late connect response after timeout never installs account listeners', async () => {
  const fixture = makeInjected(); const delayed = deferred(); fixture.provider.connect = () => delayed.promise;
  await assert.rejects(connectWallet('Phantom', undefined, fixture.scope, { timeoutMs: 5 }), /вовремя/);
  delayed.resolve({ publicKey: fixture.provider.publicKey }); await tick(); assert.equal(fixture.listeners.size, 0);
});

test('injected invalid account, missing event cleanup and silent account switches cannot sign', async () => {
  const fixture = makeInjected(); fixture.provider.publicKey = { toString: () => 'bad' };
  await assert.rejects(connectWallet('Phantom', undefined, fixture.scope), /адрес/);
  fixture.provider.publicKey = { toString: () => S.owner }; const remove = fixture.provider.removeListener; delete fixture.provider.removeListener;
  await assert.rejects(connectWallet('Phantom', undefined, fixture.scope), /события/);
  fixture.provider.removeListener = remove; const session = await connectWallet('Phantom', undefined, fixture.scope);
  fixture.provider.publicKey = { toString: () => S.laboratory };
  await assert.rejects(session.send(bytes()), /сменил аккаунт/); session.off(); assert.equal(fixture.calls.sends.length, 0);
});

test('Android, iPhone and iPad browse actions use official URLs and remove query credentials', () => {
  for (const navigator of [{ userAgent: 'Mozilla Android Chrome' }, { userAgent: 'Mozilla iPhone Safari' }, { userAgent: 'Safari', platform: 'MacIntel', maxTouchPoints: 5 }]) {
    for (const name of ['Phantom', 'Solflare', 'Backpack']) {
      const action = walletConnectionAction(name, { navigator }, 'https://user:password@coolbears-nfts.com/other?api-key=secret#rpc-secret');
      assert.equal(action.type, 'browse');
      const prefix = name === 'Phantom' ? 'https://phantom.app/ul/browse/' : name === 'Solflare' ? 'https://solflare.com/ul/v1/browse/' : 'https://backpack.app/ul/v1/browse/';
      assert.equal(action.url, `${prefix}${encodeURIComponent('https://coolbears-nfts.com/devnet/')}?ref=${encodeURIComponent('https://coolbears-nfts.com')}`);
      assert.equal(action.url.includes('secret'), false); assert.equal(action.url.includes('password'), false);
    }
  }
});

test('desktop/http/unknown-wallet fallback is explicit; detected wallet and ID connect in place', t => {
  assert.equal(walletConnectionAction('Phantom', {}, 'https://coolbears-nfts.com/devnet/').type, 'unavailable');
  assert.equal(walletConnectionAction('Phantom', { navigator: { userAgent: 'Android' } }, 'http://localhost/devnet/').type, 'unavailable');
  assert.equal(walletConnectionAction('Unknown Wallet', { navigator: { userAgent: 'Android' } }, 'https://coolbears-nfts.com/devnet/').type, 'unavailable');
  const fixture = makeStandard(t, 'Backpack'); const [{ id }] = getAvailableWallets({});
  assert.equal(walletConnectionAction(id, {}, 'http://localhost/').type, 'connect');
  assert.equal(walletConnectionAction(fixture.wallet.name, {}, 'http://localhost/').type, 'connect');
  assert.equal(fixture.calls.connects, 0);
});
