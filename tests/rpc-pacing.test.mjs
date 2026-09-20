import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pacedRpcFetch,isRateLimit} from '../solana/rpc-pacing.mjs';
import {runUpload} from '../solana/upload-runner.mjs';
test('RPC requests are serialized and spaced; HTTP429 is not replayed and Retry-After is respected',async()=>{
 let clock=0,active=0;const starts=[];
 const p=pacedRpcFetch({now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async()=>{
  assert.equal(active++,0);starts.push(clock);await Promise.resolve();active--;
  return {status:starts.length===2?429:200,headers:{get:()=> '45'}};
 }});
 await Promise.all([p.fetch('a'),p.fetch('b'),p.fetch('c')]);
 assert.deepEqual(starts,[0,1500,46500]);assert.equal(p.retryAfter(),0);
});
test('RPC handles date Retry-After and default 30 second cooldown',async()=>{
 for(const header of [null,'nonsense',new Date(90000).toUTCString()]){
  let clock=0;const p=pacedRpcFetch({now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async()=>({status:429,headers:{get:()=>header}})});
  await p.fetch('a');assert.equal(p.retryAfter(),header?.includes('GMT')?90000:30000);
 }
 assert.equal(isRateLimit(Error('429 : Connection rate limits exceeded')),true);assert.equal(isRateLimit(Error('User rejected')),false);
});
test('429 does not trigger an automatic retry or countdown',async()=>{
 let calls=0,waited=0;const flags=[],phases=[];
 const client={groupStep:async o=>{flags.push(o.sign);calls++;throw Error('429 rate limit');}};
 const result=await runUpload(client,{size:1,onProgress:r=>phases.push(r.status),sleep:async ms=>{waited+=ms;}});
 assert.equal(result.status,'rate-limited');assert.deepEqual(flags,[true]);assert.equal(calls,1);assert.equal(waited,0);assert.deepEqual(phases,['rate-limited']);
});
test('Manual mode performs exactly one group step per click',async()=>{
 const flags=[];const result=await runUpload({groupStep:async o=>{flags.push(o.sign);return {status:'submitted'};}},{size:1,sleep:async()=>{throw Error('must not sleep');}});
 assert.equal(result.status,'submitted');assert.deepEqual(flags,[true]);
});
