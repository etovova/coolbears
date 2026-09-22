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
