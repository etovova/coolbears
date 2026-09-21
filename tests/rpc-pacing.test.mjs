import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pacedRpcFetch,isRateLimit} from '../solana/rpc-pacing.mjs';
import {runUpload} from '../solana/upload-runner.mjs';
const read={body:JSON.stringify({method:'getAccountInfo',params:[]})};
test('Manual requests are serialized with no artificial wait',async()=>{
 let active=0,calls=0;const p=pacedRpcFetch({sleep:()=>{throw Error('unexpected wait');},fetch:async()=>{
  assert.equal(active++,0);calls++;await Promise.resolve();active--;return new Response('ok');
 }});
 await Promise.all([p.fetch('rpc',read),p.fetch('rpc',read)]);assert.equal(calls,2);
});
test('429 cooldown is per endpoint; next check uses the healthy reader immediately',async()=>{
 const urls=[];const p=pacedRpcFetch({now:()=>0,fallbackEndpoints:['backup'],sleep:()=>{throw Error('must not wait');},fetch:async url=>{
  urls.push(url);return new Response(url==='primary'?'limited':'ok',{status:url==='primary'?429:200,headers:{'retry-after':'45'}});
 }});
 assert.equal(await (await p.fetch('primary',read)).text(),'ok');
 assert.equal(await (await p.fetch('primary',read)).text(),'ok');
 assert.deepEqual(urls,['primary','backup','backup']);
});
test('Both limited readers fail promptly without sending requests during Retry-After',async()=>{
 let clock=0,calls=0;const p=pacedRpcFetch({now:()=>clock,fallbackEndpoints:['backup'],sleep:()=>{throw Error('must not wait');},fetch:async()=>{
  calls++;return new Response('limited',{status:429,headers:{'retry-after':'45'}});
 }});
 await assert.rejects(p.fetch('primary',read),isRateLimit);assert.equal(calls,2);
 await assert.rejects(p.fetch('primary',read),isRateLimit);assert.equal(calls,2);
 clock=45000;await assert.rejects(p.fetch('primary',read),isRateLimit);assert.equal(calls,4);
});
test('JSON RPC 429, network failure, stalled body and service outage may fail over for reads',async()=>{
 for(const mode of ['json','network','headers','body','service']){
  const urls=[];let primarySignal;
  const p=pacedRpcFetch({timeout:15,fallbackEndpoints:['backup'],fetch:async(url,options)=>{
   urls.push(url);if(url==='backup')return new Response('ok');primarySignal=options.signal;
   if(mode==='json')return new Response(JSON.stringify({error:{code:429,message:'Too many requests'}}));
   if(mode==='network')throw new TypeError('Failed to fetch');
   if(mode==='headers')return new Promise(()=>{});
   if(mode==='body')return {status:200,text:()=>new Promise(()=>{})};
   return new Response('unavailable',{status:503});
  }});
  assert.equal(await (await p.fetch('primary',read)).text(),'ok',mode);assert.deepEqual(urls,['primary','backup']);
  if(['body','headers'].includes(mode))assert.equal(primarySignal.aborted,true);
 }
});
test('Writes, unknown methods and mixed batches never fail over or replay',async()=>{
 for(const payload of [{method:'sendTransaction'},{method:'sendRawTransaction'},{method:'requestAirdrop'},[{method:'getSlot'},{method:'sendTransaction'}]]){
  const urls=[];const p=pacedRpcFetch({fallbackEndpoints:['backup'],fetch:async url=>{urls.push(url);return new Response('limited',{status:429});}});
  await assert.rejects(p.fetch('primary',{body:JSON.stringify(payload)}),isRateLimit);assert.deepEqual(urls,['primary']);
 }
});
test('Retry-After date or seconds respected; invalid or absent header uses endpoint cooldown',async()=>{
 for(const [header,expected] of [[null,30000],['nonsense',30000],['45',45000],[new Date(90000).toUTCString(),90000]]){
  const p=pacedRpcFetch({now:()=>0,fetch:async()=>new Response('limited',{status:429,headers:header?{'retry-after':header}:{}})});
  await assert.rejects(p.fetch('rpc',read),e=>isRateLimit(e)&&e.retryAfterMs===expected);
 }
 assert.equal(isRateLimit(Error('429 : Connection rate limits exceeded')),true);assert.equal(isRateLimit(Error('User rejected')),false);
});
test('429 does not restart upload or request another signature',async()=>{
 let calls=0;const phases=[];
 const result=await runUpload({groupStep:async o=>{assert.equal(o.size,1);assert.equal(o.sign,true);calls++;throw Error('429 rate limit');}},{onProgress:r=>phases.push(r.status)});
 assert.equal(result.status,'rate-limited');assert.equal(calls,1);assert.deepEqual(phases,['rate-limited']);
});
