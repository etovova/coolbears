import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {TARGET} from '../solana/load-model.mjs';
import {phantomBrowseUrl} from '../wallet-core.mjs';
const app=(await readFile('solana-load/app.mjs','utf8')).replace(/^import .*\n/gm,'');
function ui({injected=true,userAgent='Android Chrome',maxTouchPoints=0,legacy=false,initialState={}}={}){
 const elements=new Map(),handlers={},data=new Map(),calls={inspect:0,upload:0,connect:0,writes:0,recover:0},timers=new Set();
 const get=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',value:'',checked:false,disabled:false,hidden:false,dataset:{},focus(){},select(){}});return elements.get(id);};
 let state={progress:{loaded:1950,slot:42,checkedAt:new Date().toISOString()},pending:false,lastAttempt:null,...initialState},inspectFail;
 const provider={isPhantom:true,publicKey:null,on:(name,fn)=>handlers[name]=fn,connect:async()=>{calls.connect++;provider.publicKey={toString:()=>TARGET.owner};},disconnect:async()=>{provider.publicKey=null;handlers.disconnect?.();}};
 const client={inspect:async()=>{calls.inspect++;if(inspectFail)throw Error(inspectFail);return state;},upload:async()=>{calls.upload++;state={...state,progress:{...state.progress,loaded:1975},lastAttempt:{start:1950,count:25,outcome:'account-verified'}};return state;},backup:()=>JSON.stringify(state)};
 client.recoverUnapproved=async declaration=>{calls.recover++;assert.equal(declaration.notApproved,true);assert.equal(declaration.attemptId,state.recoveryId);if(inspectFail)throw Error(inspectFail);state={...state,pending:false,recoveryId:null,nextCount:1,lastAttempt:{...state.lastAttempt,outcome:'owner-reported-unapproved'}};return state;};
 const window={location:new URL('https://coolbears-nfts.com/solana-load/?api-key=never-forward#private')};
 if(injected){if(legacy)window.solana=provider;else window.phantom={solana:provider};}
 const scope={document:{getElementById:get},window,navigator:{userAgent,maxTouchPoints},phantomBrowseUrl,TARGET,SETTINGS_KEY:'rpc',DEFAULT_RPC:'https://api.devnet.solana.com',rpcUrl:x=>new URL(x).href,browserStore:()=>({read:k=>data.get(k),write:(k,v)=>{calls.writes++;data.set(k,v);}}),loadClient:()=>client,Intl,Date,setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn)};
 runInNewContext(app,scope);
 return {get,calls,provider,handlers,timers,window,fail:message=>inspectFail=message,setState:next=>state={...state,...next}};
}
test('mobile Chrome opens the same page in Phantom without connecting, RPC calls or exporting secrets',async()=>{
 const f=ui({injected:false}),link=f.get('wallet-open');
 assert.equal(link.hidden,false);assert.equal(link.textContent,'Открыть в Phantom');assert.equal(f.get('connect').hidden,true);
 const url=new URL(link.href);assert.equal(url.origin,'https://phantom.app');assert.equal(decodeURIComponent(url.pathname.slice('/ul/browse/'.length)),'https://coolbears-nfts.com/solana-load/');assert.equal(url.searchParams.get('ref'),'https://coolbears-nfts.com');assert.equal([...url.searchParams.keys()].join(','),'ref');
 let prevented=false;await link.onclick({preventDefault(){prevented=true;}});assert.equal(prevented,false);
 assert.deepEqual(f.calls,{inspect:0,upload:0,connect:0,writes:0,recover:0});assert.equal(f.get('upload').disabled,true);assert.equal(f.get('check').disabled,true);
});
test('Phantom in-app provider connects directly, including legacy injection',async()=>{
 for(const legacy of [false,true]){const f=ui({legacy});assert.equal(f.get('wallet-open').hidden,true);assert.equal(f.get('connect').hidden,false);await f.get('connect').onclick();assert.equal(f.calls.connect,1);assert.equal(f.calls.inspect,1);assert.equal(f.calls.upload,0);}
});
test('late Phantom injection uses the provider instead of navigating away',async()=>{
 const f=ui({injected:false});f.window.phantom={solana:f.provider};let prevented=false;
 await f.get('wallet-open').onclick({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.calls.connect,1);assert.equal(f.calls.inspect,1);assert.equal(f.get('wallet-open').hidden,true);
});
test('iPad desktop user agent opens Phantom while desktop without extension offers installation',()=>{
 const tablet=ui({injected:false,userAgent:'Macintosh Safari',maxTouchPoints:5});assert.equal(tablet.get('wallet-open').textContent,'Открыть в Phantom');
 const desktop=ui({injected:false,userAgent:'Macintosh Chrome'});assert.equal(desktop.get('wallet-open').href,'https://phantom.com/download');assert.equal(desktop.get('wallet-open').textContent,'Установить Phantom');
});
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
test('connecting with unresolved send never says upload can continue and keeps wallet reason visible',async()=>{
 const f=ui({initialState:{pending:true,lastAttempt:{start:1950,count:25,outcome:'unknown',message:'Phantom не подтвердил отправку.',walletError:{code:-32603,detail:'Preflight unavailable'}}}});
 await f.get('connect').onclick();assert.equal(f.get('upload').disabled,true);assert.match(f.get('activity').textContent,/остановлена/);assert.doesNotMatch(f.get('activity').textContent,/Можно продолжать/);
 assert.match(f.get('attempt').textContent,/Preflight unavailable/);
 await f.get('check').onclick();assert.match(f.get('attempt').textContent,/Preflight unavailable/);assert.equal(f.calls.upload,0);
});
test('wallet switch clears actionable state',async()=>{
 const f=ui();await f.get('connect').onclick();f.provider.publicKey={toString:()=> 'other'};f.handlers.accountChanged();assert.equal(f.get('upload').disabled,true);assert.equal(f.get('check').disabled,true);
});
test('unapproved recovery is an explicit read-only action; a separate button starts one record',async()=>{
 const f=ui({initialState:{pending:true,recoveryId:'attempt-1',lastAttempt:{start:1950,count:25,outcome:'unknown'}}});
 assert.equal(f.get('recovery').hidden,true);await f.get('connect').onclick();assert.equal(f.get('recovery').hidden,false);assert.equal(f.get('recover').disabled,true);
 await f.get('recover').onclick();assert.equal(f.calls.recover,0);
 f.get('not-approved').checked=true;f.get('not-approved').onchange();assert.equal(f.get('recover').disabled,false);await f.get('recover').onclick();
 assert.equal(f.calls.recover,1);assert.equal(f.calls.upload,0);assert.equal(f.get('recovery').hidden,true);assert.equal(f.get('upload').textContent,'Загрузить 1 запись');assert.equal(f.get('upload').disabled,false);
 assert.match(f.get('attempt').textContent,/сохранена в истории/);await f.get('check').onclick();assert.equal(f.calls.upload,0);assert.equal(f.get('upload').textContent,'Загрузить 1 запись');
 await f.get('upload').onclick();assert.equal(f.calls.upload,1);
});
test('stale declaration resets on attempt change and RPC failure keeps upload blocked',async()=>{
 const f=ui({initialState:{pending:true,recoveryId:'attempt-1'}});await f.get('connect').onclick();f.get('not-approved').checked=true;f.get('not-approved').onchange();
 f.setState({recoveryId:'attempt-2'});await f.get('check').onclick();assert.equal(f.get('not-approved').checked,false);assert.equal(f.get('recover').disabled,true);
 f.get('not-approved').checked=true;f.get('not-approved').onchange();f.fail('RPC не ответил');await f.get('recover').onclick();assert.equal(f.get('upload').disabled,true);assert.equal(f.calls.upload,0);assert.equal(f.get('activity').dataset.error,'true');
 f.handlers.disconnect();assert.equal(f.get('recovery').hidden,true);assert.equal(f.get('not-approved').checked,false);
});
test('new UI has one upload control, no setup/rehearsal or bulk signing controls',async()=>{
 const html=await readFile('solana-load/index.html','utf8');assert.equal((html.match(/id="upload"/g)||[]).length,1);assert.doesNotMatch(html,/250|Создать|репетиц|signAll/);assert.match(html,/id="attempt"/);assert.match(html,/type="password"/);
});
