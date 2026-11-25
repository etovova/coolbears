import test from 'node:test';
import assert from 'node:assert/strict';
import {handle,REVEAL_AT,OWNER} from './worker.mjs';
const host='https://preview.invalid';
const request=(path,env={},when=REVEAL_AT-1,method='GET')=>handle(new Request(host+path,{method}),env,when);
test('all slots stay closed before the exact UTC boundary',async()=>{
  assert.equal(new Date(REVEAL_AT).toISOString(),'2027-02-01T00:00:00.000Z');
  let reads=0;const env={ASSETS:{fetch(){reads++;throw Error();}}};
  for(let i=0;i<10000;i++){
    const slot=String(i).padStart(4,'0');
    const r=await request('/xrpl/metadata/'+slot+'.json?now=9999999999',env);
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await r.json()).image,host+'/xrpl/cover.gif');
    assert.equal((await request('/xrpl/art/'+slot+'.png',env)).status,404);
  }
  assert.equal(reads,0);
});
test('only public routes work and storage failures are retryable',async()=>{
  for(const path of ['/internal/p000.bin','/internal/m00.json','/xrpl/metadata/10000.json','/xrpl/metadata/0000.png','/xrpl/art/0000.json'])
    assert.equal((await request(path)).status,404);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT)).status,503);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT-1,'HEAD')).body,null);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT-1,'POST')).status,405);
});
test('the public sale remains closed on the main domain',async()=>{
 const r=await handle(new Request('https://coolbears-nfts.com/xrpl/api/status'),{NETWORK:'testnet',SALES_OPEN:'yes',TEST_ISSUER:'fixture'});
 const s=await r.json();assert.equal(s.issuer,OWNER);assert.equal(s.open,false);assert.equal(s.network,'Mainnet');assert.equal(s.price,'10000000');
});
