import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isRateLimit} from '../solana/rpc-pacing.mjs';
import {readWithRecovery} from '../solana/read-runner.mjs';
import {runInNewContext} from 'node:vm';
async function setup(groupSupported=true){
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:id==='group-size'?'10':'',select(){}});return elements.get(id);};
 let handler,options;
 const state={collection:'collection',machine:'machine'},wallet={address:'owner',provider:{},connect:async()=>{},disconnect:async()=>{}};
 const client={groupSupported:()=>groupSupported,read:async()=>({state,collection:true,machine:true,loaded:1775,balance:.29})};
 const scope={isRateLimit,AbortController,readWithRecovery:(c,o)=>readWithRecovery(c,{...o,timeout:30,sleep:async()=>{}}),document:{getElementById:get},URL,location:{href:'https://coolbears-nfts.com/solana-upload/'},createWalletUI:()=>wallet,browserUploadStore:()=>({}),uploadClient:()=>client,runUpload:async(c,o)=>{options=o;return handler(o);}};
 const source=(await readFile('solana-upload/controller.mjs','utf8')).replace(/^import .*\n/gm,'');runInNewContext(source,scope);
 await get('refresh').onclick();
 return {get,client,setHandler:f=>handler=f,options:()=>options};
}
test('Operator disables competing actions during upload, shows progress and enables stop',async()=>{
 const f=await setup();assert.equal(f.get('step').disabled,false);
 f.setHandler(async o=>{assert.equal(f.get('connect').disabled,true);assert.equal(f.get('step').disabled,true);assert.equal(f.get('stop').disabled,false);o.onProgress({status:'verified',loaded:2025});assert.equal(f.get('progress').value,2025);f.get('stop').onclick();assert.equal(o.stopped(),true);return {status:'stopped'};});
 await f.get('step').onclick();assert.equal(f.get('step').disabled,false);assert.equal(f.get('stop').disabled,true);assert.match(f.get('status').textContent,/остановлена/);
});
test('Unsupported group signer and wallet rejection are visible, no hidden automatic restart',async()=>{
 const f=await setup(false);assert.equal(f.get('group-size').disabled,true);assert.match(f.get('group-info').textContent,/одиночную/);
 f.setHandler(async()=>{throw Error('User rejected');});await f.get('step').onclick();assert.match(f.get('status').textContent,/rejected/);assert.equal(f.get('refresh').disabled,false);assert.equal(f.get('stop').disabled,true);
});
test('Stale 429 is replaced immediately; cancelling a hung check unlocks controls and ignores late result',async()=>{
 const f=await setup();let resolve,signal;
 f.get('status').textContent='Сервер Solana ограничил запросы.';
 f.client.read=o=>{signal=o.signal;return new Promise(r=>{resolve=r;});};
 const pending=f.get('refresh').onclick();
 assert.match(f.get('status').textContent,/Проверяю состояние/);
 assert.equal(f.get('cancel-check').hidden,false);assert.equal(f.get('cancel-check').disabled,false);
 f.get('cancel-check').onclick();await pending;
 assert.ok(signal);assert.equal(f.get('refresh').disabled,false);assert.equal(f.get('connect').disabled,false);
 assert.equal(f.get('step').disabled,true);assert.equal(f.get('cancel-check').hidden,true);
 assert.match(f.get('status').textContent,/отменена/);
 resolve({loaded:9999});await new Promise(r=>setImmediate(r));assert.equal(f.get('progress').value,1775);
});
test('A hung check times out; repeated rate limits stop after three reads; next check recovers',async()=>{
 const f=await setup(),original=f.client.read;
 f.client.read=()=>new Promise(()=>{});await f.get('refresh').onclick();
 assert.match(f.get('status').textContent,/не завершилась/);assert.equal(f.get('refresh').disabled,false);
 let calls=0;f.client.read=async()=>{calls++;throw Error('429');};await f.get('refresh').onclick();
 assert.equal(calls,3);assert.equal(f.get('connect').disabled,false);assert.match(f.get('status').textContent,/кнопки доступны/);
 f.client.read=original;await f.get('refresh').onclick();assert.equal(f.get('step').disabled,false);assert.match(f.get('status').textContent,/обновлено/);
});
