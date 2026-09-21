import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoolBearsClient } from '../chain/runtime.mjs';
import { SPEC } from '../chain/spec.mjs';
function client() {
  const m = new Map(); return new CoolBearsClient({ provider: { publicKey: SPEC.owner }, address: SPEC.owner,
    endpoint: 'https://api.devnet.solana.com', storage: { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v) } });
}
test('stable deployment addresses across resume without wallet secrets', () => {
  const c=client(), state=c.init('ab'.repeat(32));
  assert.equal(c.init('ab'.repeat(32)).collection.address,state.collection.address);
  assert.equal(c.signer(state.collection).publicKey,state.collection.address);
  assert.throws(()=>c.init('cd'.repeat(32)),/does not match/); assert.notEqual(state.collection.address,SPEC.owner);
});
test('changed wallet and insecure RPC fail before signing', async () => {
  const c=client(); c.provider.publicKey='11111111111111111111111111111111';
  await assert.rejects(c.checkNetwork(),/Wallet account changed/);
  assert.throws(()=>new CoolBearsClient({address:SPEC.owner,provider:{},endpoint:'http://example.com'}),/HTTPS/);
});
test('pending operation cannot request another signature before expiry', async () => {
  const c=client(); c.connection.getBlockHeight=async()=>100;
  c.journal.put('op',{state:'unknown',lastValidBlockHeight:100});
  await assert.rejects(c.operationUnlocked('op','target',{},async()=>false),/has not expired/);
});
test('network mismatch blocks before Metaplex or wallet actions', async () => {
  const c=client(); c.connection.getGenesisHash=async()=> 'wrong-network';
  await assert.rejects(c.checkNetwork(),/network does not match/);
});
test('foreign account is not treated as a completed operation', async () => {
  const c=client(); c.connection.getAccountInfo=async()=>({owner:{toBase58:()=> 'wrong-program'}});
  await assert.rejects(c.exists(SPEC.owner,'expected-program'),/unexpected program/);
});
