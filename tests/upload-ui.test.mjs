import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isRateLimit} from '../solana/rpc-pacing.mjs';
import {runUpload} from '../solana/upload-runner.mjs';
import {runInNewContext} from 'node:vm';
async function setup(){ 
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:'',select(){}});return elements.get(id);};
 let handler,options;
 const state={collection:'collection',machine:'machine'},wallet={address:'owner',provider:{},connect:async()=>{},disconnect:async()=>{}};
 const client={read:async()=>({state,collection:true,machine:true,loaded:1775,balance:null})};
 const scope={isRateLimit,document:{getElementById:get},URL,location:{href:'https://coolbears-nfts.com/solana-upload/'},createWalletUI:()=>wallet,browserUploadStore:()=>({}),uploadClient:()=>client,runUpload:async(c,o)=>{options=o;return handler(o);}};
 const source=(await readFile('solana-upload/controller.mjs','utf8')).replace(/^import .*\n/gm,'');runInNewContext(source,scope);
 await get('refresh').onclick();
 return {get,setHandler:f=>handler=f,options:()=>options};
}
test('Manual UI performs one group and leaves the next press to the operator',async()=>{
 const f=await setup();assert.equal(f.get('step').disabled,false);
 f.setHandler(async o=>{assert.equal(o.size,1);assert.equal(f.get('connect').disabled,true);assert.equal(f.get('step').disabled,true);o.onProgress({status:'verified',loaded:2025});return {status:'verified',loaded:2025};});
 await f.get('step').onclick();assert.equal(f.get('step').disabled,false);assert.match(f.get('status').textContent,/подтверждён/);
});
test('Wallet rejection is visible and does not trigger a hidden restart',async()=>{
 const f=await setup();f.setHandler(async()=>{throw Error('User rejected');});await f.get('step').onclick();assert.match(f.get('status').textContent,/rejected/);assert.equal(f.get('refresh').disabled,false);
});
test('Runner performs exactly one manual group without waiting or retrying',async()=>{
 let calls=0,slept=0;
 const result=await runUpload({groupStep:async options=>{calls++;assert.equal(options.size,1);assert.equal(options.sign,true);return {status:'submitted',loaded:1775};}},{size:1,onProgress:()=>{},sleep:async ms=>{slept+=ms;}});
 assert.equal(result.status,'submitted');assert.equal(calls,1);assert.equal(slept,0);
});
test('Published page contains no automatic group controls',async()=>{
 const html=await readFile('solana-upload/index.html','utf8');
 assert.doesNotMatch(html,/continuous|group-size|Остановить загрузку|до 125|до 250/);
 assert.doesNotMatch(html,/id="collection"|id="machine"/);
 assert.match(html,/solana-test/);
});
