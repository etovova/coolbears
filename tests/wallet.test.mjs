import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWalletSession, detectWallets, phantomBrowseUrl } from '../wallet-core.mjs';

function provider() {
  const p = new EventEmitter();
  p.isPhantom = true;
  p.connect = async () => ({ publicKey: '9wPublicSolanaTestAddressOnly11111111111111111' });
  p.disconnect = async () => p.emit('disconnect');
  return p;
}
test('Connection, account change, permission revocation and reconnect keep the correct address', async () => {
  const p = provider(), changes = [];
  const session = createWalletSession(address => changes.push(address));
  assert.equal(await session.connect(p), '9wPublicSolanaTestAddressOnly11111111111111111');
  p.emit('accountChanged', { toString: () => 'ChangedAccount' });
  assert.equal(session.address, 'ChangedAccount');
  p.emit('accountChanged', null);
  assert.equal(session.address, '');
  await session.connect(p);
  assert.equal(p.listenerCount('disconnect'), 1);
  await session.disconnect();
  assert.equal(session.address, '');
  assert.equal(session.provider, null);
  assert.equal(p.listenerCount('accountChanged'), 0);
  assert.equal(changes.at(-1), '');
});
test('Declined connection never becomes connected or signs anything', async () => {
  const p = provider();
  p.connect = async () => { throw Object.assign(new Error('Declined'), { code: 4001 }); };
  p.signTransaction = () => assert.fail('Connecting must not sign');
  const session = createWalletSession();
  await assert.rejects(session.connect(p), { code: 4001 });
  assert.equal(session.address, '');
  assert.equal(session.provider, null);
});
test('A failed disconnect retains the connection for retry', async () => {
  const p = provider(), session = createWalletSession();
  await session.connect(p);
  p.disconnect = async () => { throw new Error('Disconnected failed'); };
  await assert.rejects(session.disconnect());
  assert.ok(session.address);
  assert.equal(session.provider, p);
});
test('Solana-specific provider is selected; EVM provider is ignored', () => {
  const p = provider();
  assert.deepEqual(detectWallets({ phantom: { solana: p, ethereum: {} } }), [{ name: 'Phantom', provider: p }]);
  assert.deepEqual(detectWallets({ ethereum: p }), []);
});
test('Mobile link opens this exact HTTPS page in Phantom without sharing secrets', () => {
  const link = new URL(phantomBrowseUrl('https://coolbears-nfts.com/solana-test/?lang=ru#section'));
  assert.equal(link.origin, 'https://phantom.app');
  assert.equal(decodeURIComponent(link.pathname.slice('/ul/browse/'.length)), 'https://coolbears-nfts.com/solana-test/?lang=ru');
  assert.equal(link.searchParams.get('ref'), 'https://coolbears-nfts.com');
  assert.throws(() => phantomBrowseUrl('javascript:alert(1)'));
});
