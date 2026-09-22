import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletSession, walletDeadline } from '../wallet-core.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function provider(address) {
  const listeners = new Map();
  return {
    publicKey: address,
    async connect() { return { publicKey: this.publicKey }; },
    async disconnect() {},
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name, value) { for (const callback of [...(listeners.get(name) || [])]) callback(value); },
    listeners() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

test('wallet deadline returns control and preserves wallet rejection codes', async () => {
  await assert.rejects(walletDeadline(new Promise(() => {}), 5), error => error.code === 'WALLET_TIMEOUT');
  const rejection = Object.assign(Error('Cancelled'), { code: 4001 });
  await assert.rejects(walletDeadline(Promise.reject(rejection)), error => error === rejection);
});

test('timed out connection cannot attach listeners or replace a later wallet', async () => {
  const first = provider('first'), second = provider('second');
  const pending = deferred();
  first.connect = () => pending.promise;
  const changes = [];
  const session = createWalletSession(address => changes.push(address), { timeoutMs: 8 });
  await assert.rejects(session.connect(first), error => error.code === 'WALLET_TIMEOUT');
  await session.connect(second);
  pending.resolve({ publicKey: 'first' });
  await Promise.resolve();
  first.emit('accountChanged', 'stale');
  assert.equal(session.provider, second);
  assert.equal(session.address, 'second');
  assert.equal(first.listeners(), 0);
  assert.deepEqual(changes, ['second']);
});

test('newer connection wins when two provider replies arrive out of order', async () => {
  const first = provider('first'), second = provider('second');
  const pending = deferred();
  first.connect = () => pending.promise;
  const session = createWalletSession();
  const connecting = session.connect(first);
  await session.connect(second);
  pending.resolve({ publicKey: 'first' });
  await assert.rejects(connecting, error => error.name === 'AbortError');
  assert.equal(session.address, 'second');
  assert.equal(first.listeners(), 0);
});

test('late disconnect reply or event cannot clear a newly selected provider', async () => {
  const first = provider('first'), second = provider('second');
  const pending = deferred();
  first.disconnect = () => pending.promise;
  const changes = [];
  const session = createWalletSession(address => changes.push(address));
  await session.connect(first);
  const disconnecting = session.disconnect();
  await session.connect(second);
  pending.resolve();
  await disconnecting;
  first.emit('disconnect');
  assert.equal(session.provider, second);
  assert.equal(session.address, 'second');
  assert.equal(first.listeners(), 0);
  assert.deepEqual(changes, ['first', 'second']);
});

test('disconnect timeout remains retryable and does not falsely claim disconnection', async () => {
  const selected = provider('selected');
  selected.disconnect = () => new Promise(() => {});
  const session = createWalletSession(() => {}, { timeoutMs: 8 });
  await session.connect(selected);
  await assert.rejects(session.disconnect(), error => error.code === 'WALLET_TIMEOUT');
  assert.equal(session.address, 'selected');
  selected.disconnect = async () => {};
  await session.disconnect();
  assert.equal(session.address, '');
  assert.equal(selected.listeners(), 0);
});
