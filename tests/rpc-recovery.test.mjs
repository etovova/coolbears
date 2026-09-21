import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {pacedRpcFetch} from '../solana/rpc-pacing.mjs';
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
test('Actual Umi/web3 client reads the machine once and retains saved addresses',async()=>{
 const requests=[];const f=fixture(async(url,options)=>{assert.equal(url,'https://devnet.rpcpool.com');requests.push(JSON.parse(options.body));return answer(options);});
 const result=await f.client.read({signal:new AbortController().signal});
 assert.deepEqual(requests.map(r=>r.method),['getAccountInfo']);
 assert.ok(requests.filter(r=>r.method==='getAccountInfo').every(r=>!r.params[1]||r.params[1].commitment==='confirmed'));
 assert.deepEqual(result.state,f.state);assert.equal(result.balance,null);assert.equal(f.writes(),0);assert.equal(f.locked(),false);
});
test('Actual Umi/web3 stalled RPC releases lock after timeout or cancellation and permits next read',async()=>{
 for(const cancel of [false,true]){
  let hang=true;const f=fixture(async(_url,options)=>hang?new Promise(()=>{}):answer(options));
  const abort=new AbortController();const pending=f.client.read({signal:abort.signal});
  const rejected=assert.rejects(pending,/вовремя|abort/i);
  if(cancel){await new Promise(r=>setImmediate(r));abort.abort();}
  await rejected;assert.equal(f.locked(),false);assert.equal(f.writes(),0);
  hang=false;const result=await f.client.read();assert.deepEqual(result.state,f.state);assert.equal(f.locked(),false);
 }
});
