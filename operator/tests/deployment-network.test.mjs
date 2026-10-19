import test from 'node:test';
import assert from 'node:assert/strict';
import { networkProfile, networkSendAuthorized, GENESIS_HASHES } from '../deployment/network.mjs';

test('network identities are immutable and use full genesis hashes and Wallet Standard chain names', () => {
  for (const [cluster, walletChain, hostname] of [['devnet', 'solana:devnet', 'devnet.helius-rpc.com'],
    ['mainnet-beta', 'solana:mainnet', 'mainnet.helius-rpc.com']]) {
    const profile = networkProfile(cluster);
    assert.equal(profile.cluster, cluster); assert.equal(profile.walletChain, walletChain);
    assert.equal(profile.genesisHash, GENESIS_HASHES[cluster]); assert.equal(profile.genesisHash.length > 40, true);
    assert.equal(new URL(profile.rpcUpstream).hostname, hostname);
    assert.equal(Object.isFrozen(profile), true);
    assert.throws(() => { profile.rpcUpstream = 'https://evil.test/'; }, TypeError);
    assert.equal(networkProfile(cluster), profile);
  }
  assert.equal(Object.isFrozen(GENESIS_HASHES), true);
});

test('network input cannot select an endpoint, prototype property, alias or implicit default', () => {
  for (const cluster of [undefined, null, {}, 'mainnet', 'testnet', 'DEVNET', 'constructor', '__proto__', 'https://PRIVATE_SENTINEL.test']) {
    assert.throws(() => networkProfile(cluster), error => error.code === 'DEPLOYMENT_NETWORK_INVALID'
      && !String(error).includes('PRIVATE_SENTINEL'));
  }
});

test('send authorization is strict, exclusive and tied to the selected network', () => {
  for (const cluster of ['devnet', 'mainnet-beta']) {
    assert.equal(networkSendAuthorized(cluster), false);
    const valid = cluster === 'devnet' ? { authorizeDevnetSend: true } : { authorizeMainnetSend: true };
    assert.equal(networkSendAuthorized(cluster, valid), true);
    for (const flags of [{ authorizeDevnetSend: true, authorizeMainnetSend: true },
      { authorizeDevnetSend: 'true' }, { authorizeMainnetSend: 1 },
      cluster === 'devnet' ? { authorizeMainnetSend: true } : { authorizeDevnetSend: true }]) {
      assert.equal(networkSendAuthorized(cluster, flags), false);
    }
  }
});
