import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isRateLimit} from '../solana/rpc-pacing.mjs';
import {runInNewContext} from 'node:vm';
async function setup(groupSupported=true){
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:id==='group-size'?'10':'',select(){}});return elements.get(id);};
 let handler,options;
 const state={collection:'collection',machine:'machine'},wallet={address:'owner',provider:{},connect:async()=>{},disconnect:async()=>{}};
 const client={groupSupported:()=>groupSupported,read:async()=>({state,collection:true,machine:true,loaded:1775,balance:.29})};
 const scope={isRateLimit,document:{getElementById:get},URL,location:{href:'https://coolbears-nfts.com/solana-upload/'},createWalletUI:()=>wallet,browserUploadStore:()=>({}),uploadClient:()=>client,runUpload:async(c,o)=>{options=o;return handler(o);}};
 const source=(await readFile('solana-upload/controller.mjs','utf8')).replace(/^import .*\n/gm,'');runInNewContext(source,scope);
 await get('refresh').onclick();
 return {get,setHandler:f=>handler=f,options:()=>options};
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
