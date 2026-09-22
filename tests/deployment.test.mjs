import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentRpc, validateSiteRpcEndpoint } from '../devnet/deployment.mjs';
import { settings as S } from '../devnet/settings.mjs';

const relay = 'https://coolbears-rpc.example.com/rpc';

test('blank deployment preserves the public fallback and canonical relay selects site RPC', () => {
  assert.deepEqual(deploymentRpc(''), { endpoint: new URL(S.rpc).href, kind: 'public-devnet' });
  assert.equal(validateSiteRpcEndpoint(relay), relay);
  const configured = deploymentRpc(relay);
  assert.deepEqual(configured, { endpoint: relay, kind: 'site-devnet' });
  assert.equal(Object.isFrozen(configured), true);
  assert.deepEqual(deploymentRpc(), deploymentRpc(S.siteRpc));
});

test('deployment configuration rejects credentials and reports only a fixed safe error', () => {
  const messages = new Set();
  for (const endpoint of [
    `${relay}?api-key=deployment-secret-sentinel`, `${relay}#deployment-secret-sentinel`,
    'https://user:deployment-secret-sentinel@coolbears-rpc.example.com/rpc',
    'https://coolbears-rpc.example.com/deployment-secret-sentinel',
  ]) assert.throws(() => deploymentRpc(endpoint), error => {
    assert.doesNotMatch(error.message, /deployment-secret-sentinel|api-key|https?:|example\.com/);
    messages.add(error.message);
    return true;
  });
  assert.equal(messages.size, 1);
});

test('deployment rejects noncanonical URLs and local or nonpublic hostnames', () => {
  for (const endpoint of [
    'http://coolbears-rpc.example.com/rpc', 'https://coolbears-rpc.example.com:443/rpc',
    'https://coolbears-rpc.example.com:8443/rpc', 'https://COOLBEARS-rpc.example.com/rpc',
    `${relay}?`, `${relay}#`, `${relay}/`, ` ${relay}`, `${relay}\n`,
    'https://coolbears-rpc.example.com/../rpc', 'https://coolbears-rpc.example.com/%72pc',
    'https://coolbears-rpc.example.com/\\rpc', 'https://127.0.0.1/rpc', 'https://[::1]/rpc',
    'https://localhost/rpc', 'https://rpc.local/rpc', 'https://rpc.internal/rpc',
    'https://rpc.test/rpc', 'https://rpc.invalid/rpc', 'https://rpc.example/rpc',
    'https://rpc.lan/rpc', 'https://rpc.home/rpc',
  ]) assert.throws(() => validateSiteRpcEndpoint(endpoint), { name: 'Error' });
});

test('invalid configuration types fail closed instead of enabling the public fallback', () => {
  for (const value of [null, 0, false, [], { endpoint: relay }, ' ']) {
    assert.throws(() => deploymentRpc(value), { name: 'Error' });
  }
  assert.throws(() => validateSiteRpcEndpoint(undefined), { name: 'Error' });
});
