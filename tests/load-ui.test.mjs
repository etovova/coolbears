import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {TARGET} from '../solana/load-model.mjs';
const app=(await readFile('solana-load/app.mjs','utf8')).replace(/^import .*\n/,'');
function ui(){
 const elements=new Map(),handlers={},data=new Map(),calls={inspect:0,upload:0},timers=new Set();
 const get=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',value:'',disabled:false,hidden:false,dataset:{},focus(){},select(){}});return elements.get(id);};
 let state={progress:{loaded:1950,slot:42,checkedAt:new Date().toISOString()},pending:false,lastAttempt:null},inspectFail;
 const provider={isPhantom:true,publicKey:null,on:(name,fn)=>handlers[name]=fn,connect:async()=>{provider.publicKey={toString:()=>TARGET.owner};},disconnect:async()=>{provider.publicKey=null;handlers.disconnect?.();}};
 const client={inspect:async()=>{calls.inspect++;if(inspectFail)throw Error(inspectFail);return state;},upload:async()=>{calls.upload++;state={...state,progress:{...state.progress,loaded:1975},lastAttempt:{start:1950,count:25,outcome:'account-verified'}};return state;},backup:()=>JSON.stringify(state)};
 const scope={document:{getElementById:get},window:{phantom:{solana:provider}},TARGET,SETTINGS_KEY:'rpc',DEFAULT_RPC:'https://api.devnet.solana.com',rpcUrl:x=>new URL(x).href,browserStore:()=>({read:k=>data.get(k),write:(k,v)=>data.set(k,v)}),loadClient:()=>client,Intl,Date,setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn)};
 runInNewContext(app,scope);
 return {get,calls,provider,handlers,timers,fail:message=>inspectFail=message};
}
test('connect automatically reads progress, one upload updates count and preserves last result on refresh',async()=>{
 const f=ui();assert.equal(f.get('connect').disabled,false);assert.equal(f.get('upload').disabled,true);
 await f.get('connect').onclick();assert.equal(f.calls.inspect,1);assert.equal(f.get('upload').disabled,false);
 await f.get('upload').onclick();assert.equal(f.calls.upload,1);assert.match(f.get('count').textContent,/1\s?975/);
 const result=f.get('attempt').textContent;await f.get('check').onclick();assert.equal(f.get('attempt').textContent,result);assert.equal(f.calls.upload,1);
});
test('failed check retains last good count and leaves export usable',async()=>{
 const f=ui();await f.get('connect').onclick();const count=f.get('count').textContent;f.fail('RPC не ответил');
 await f.get('check').onclick();assert.equal(f.get('count').textContent,count);assert.equal(f.get('activity').dataset.error,'true');assert.equal(f.get('export').disabled,false);
 f.get('export').onclick();assert.equal(f.get('history').hidden,false);
});
test('wallet switch clears actionable state',async()=>{
 const f=ui();await f.get('connect').onclick();f.provider.publicKey={toString:()=> 'other'};f.handlers.accountChanged();assert.equal(f.get('upload').disabled,true);assert.equal(f.get('check').disabled,true);
});
test('new UI has one upload control, no setup/rehearsal or bulk signing controls',async()=>{
 const html=await readFile('solana-load/index.html','utf8');assert.equal((html.match(/id="upload"/g)||[]).length,1);assert.doesNotMatch(html,/250|Создать|репетиц|signAll/);assert.match(html,/id="attempt"/);assert.match(html,/type="password"/);
});
