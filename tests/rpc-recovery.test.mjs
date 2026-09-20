import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {pacedRpcFetch} from '../solana/rpc-pacing.mjs';
import {readWithRecovery} from '../solana/read-runner.mjs';
import {uploadClient,SETUP_KEY} from '../solana/upload-client.mjs';
import {LAUNCH_OWNER} from '../solana/launch-plan.mjs';

test('Timeout includes stalled headers and stalled body; queue recovers without replay',async()=>{
 for(const body of [false,true]){
  let calls=0,signal;
  const p=pacedRpcFetch({interval:0,timeout:15,fetch:async(_url,options)=>{
   calls++;signal=options.signal;
   if(calls>1)return new Response('recovered');
   return body?{status:200,headers:new Headers(),text:()=>new Promise(()=>{})}:new Promise(()=>{});
  }});
  await assert.rejects(p.fetch('rpc'),{name:'TimeoutError'});assert.equal(signal.aborted,true);
  assert.equal(await (await p.fetch('rpc')).text(),'recovered');assert.equal(calls,2);
 }
});
test('Abort cancels active fetch and queued work without sending it',async()=>{
 let calls=0;const first=new AbortController(),queued=new AbortController();
 const p=pacedRpcFetch({interval:0,fetch:async()=>{calls++;return new Promise(()=>{});}});
 const one=p.fetch('rpc',{signal:first.signal});const two=p.fetch('rpc',{signal:queued.signal});
 const checks=[assert.rejects(one,{name:'AbortError'}),assert.rejects(two,{name:'AbortError'})];
 await new Promise(r=>setImmediate(r));queued.abort();first.abort();await Promise.all(checks);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
test('Cooldown honours Retry-After, reports countdown, and cancellation makes no next read',async()=>{
 let clock=0,calls=0;const phases=[],abort=new AbortController();
 const p=pacedRpcFetch({interval:0,now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async()=>{calls++;return new Response('limited',{status:429,headers:{'retry-after':'45'}});}});
 await p.fetch('rpc');
 await assert.rejects(readWithRecovery({retryAfter:p.retryAfter,read:async()=>{calls++;}},{signal:abort.signal,onProgress:r=>phases.push(r),sleep:async()=>{abort.abort();}}),{name:'AbortError'});
 assert.equal(calls,1);assert.equal(phases[0].seconds,45);
});
test('Read-only retries are bounded, honour cooldown, and recover without signing',async()=>{
 let calls=0,waited=0;const phases=[];
 const result=await readWithRecovery({retryAfter:()=>calls===1?45000:0,read:async()=>{if(++calls===1)throw Error('429');return {loaded:1950};}},{sleep:async ms=>{waited+=ms;},onProgress:r=>phases.push(r)});
 assert.equal(result.loaded,1950);assert.equal(calls,2);assert.equal(waited,45000);assert.ok(phases.some(r=>r.seconds===45));
});

function fixture(fetch){
 const state={owner:LAUNCH_OWNER,cluster:'devnet',collection:'BZRkdsRsmeBBGb1JsVUbgZbThWraaMPSRazdiQdioLcy',machine:'FLpAJpBG7BDEL5cFZPiouGD6ZWnTWRRBrWxtkjVz9s3R'};
 let locked=false,writes=0;
 const store={read:key=>{assert.equal(key,SETUP_KEY);return structuredClone(state);},write:()=>{writes++;},withLock:async(key,fn)=>{assert.equal(locked,false);locked=true;try{return await fn();}finally{locked=false;}}};
 const provider={publicKey:new PublicKey(LAUNCH_OWNER),signTransaction:()=>{throw Error('must not sign');},signAllTransactions:()=>{throw Error('must not sign');}};
 const client=uploadClient(provider,store,{paced:pacedRpcFetch({fetch,interval:0,timeout:15})});
 return {client,state,locked:()=>locked,writes:()=>writes};
}
function answer(options){
 const q=JSON.parse(options.body);
 const result=q.method==='getGenesisHash'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':{context:{slot:123},value:q.method==='getBalance'?295627200:null};
 return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
}
test('Actual Umi/web3 client reads with four RPC calls and retains saved missing addresses',async()=>{
 const requests=[];const f=fixture(async(url,options)=>{assert.equal(url,'https://api.devnet.solana.com');requests.push(JSON.parse(options.body));return answer(options);});
 const result=await f.client.read({signal:new AbortController().signal});
 assert.deepEqual(requests.map(r=>r.method),['getGenesisHash','getAccountInfo','getAccountInfo','getBalance']);
 assert.ok(requests.filter(r=>r.method==='getAccountInfo').every(r=>r.params[1].commitment==='finalized'));
 assert.deepEqual(result.state,f.state);assert.equal(result.balance,.2956272);assert.equal(f.writes(),0);assert.equal(f.locked(),false);
});
test('Actual Umi/web3 stalled RPC releases lock after timeout or cancellation and permits next read',async()=>{
 for(const cancel of [false,true]){
  let hang=true;const f=fixture(async(_url,options)=>hang?new Promise(()=>{}):answer(options));
  const abort=new AbortController();const pending=f.client.read({signal:abort.signal});
  const rejected=assert.rejects(pending,/15 секунд|abort/i);
  if(cancel){await new Promise(r=>setImmediate(r));abort.abort();}
  await rejected;assert.equal(f.locked(),false);assert.equal(f.writes(),0);
  hang=false;const result=await f.client.read();assert.deepEqual(result.state,f.state);assert.equal(f.locked(),false);
 }
});
