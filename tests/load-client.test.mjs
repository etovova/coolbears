import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PublicKey} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import {MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,getAddConfigLinesInstructionDataSerializer} from '@metaplex-foundation/mpl-core-candy-machine';
import * as source from '../solana/load-client.mjs';
import * as shipped from '../solana-load/sdk.js';
import {LEGACY_KEY,GENESIS,decodeProgress,buildUpload} from '../solana/load-model.mjs';
import {readRpc} from '../solana/load-rpc.mjs';
import {account,SLOT,signature,memoryStore} from './load-fixture.mjs';
const phone=JSON.parse(await readFile(new URL('./fixtures/phone-rpc-failure.json',import.meta.url),'utf8'));
function setup(api,options={}){
 const store=options.store??memoryStore(),requests=[],urls=[];
 let walletCalls=0,count=1950,time=0;
 const provider={isPhantom:true,publicKey:new PublicKey(api.TARGET.owner),signTransaction:()=>{throw Error('legacy signing must not run');},signAllTransactions:()=>{throw Error('group signing forbidden');},async signAndSendTransaction(tx,sendOptions){
  walletCalls++;
  const intent=store.read(api.KEY)?.pending;
  assert.equal(intent.start,1950);assert.equal(intent.count,25);assert.equal(intent.phase,'wallet');
  assert.equal(tx.instructions.length,1);assert.equal(tx.instructions[0].programId.toBase58(),MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID);
  const [data]=getAddConfigLinesInstructionDataSerializer().deserialize(tx.instructions[0].data);
  assert.equal(data.index,1950);assert.equal(data.configLines.length,25);assert.equal(data.configLines[0].uri,'1950.json');
  assert.equal(tx.feePayer.toBase58(),api.TARGET.owner);assert.ok(tx.serialize({requireAllSignatures:false,verifySignatures:false}).length<=1232);
  assert.equal(sendOptions.skipPreflight,false);assert.equal(sendOptions.preflightCommitment,'confirmed');assert.equal(sendOptions.maxRetries,0);
  if(options.wallet)return options.wallet({tx,provider,store,setCount:n=>count=n,setTime:n=>time=n});
  count=1975;return {signature};
 }};
 const fetch=async(url,init)=>{
  const q=JSON.parse(init.body);requests.push(q);urls.push(url);let result;
  if(q.method==='getGenesisHash')result=GENESIS;
  else if(q.method==='getAccountInfo')result=account(count,SLOT+(count>1950?5:0));
  else if(q.method==='getLatestBlockhash')result={context:{slot:SLOT},value:{blockhash:api.TARGET.owner,lastValidBlockHeight:999999999}};
  else if(q.method==='getEpochInfo')result={absoluteSlot:SLOT-30,blockHeight:999999999};
  else if(q.method==='getSignatureStatuses')result={context:{slot:SLOT+5},value:q.params[0].map(()=>null)};
  else throw Error(`Unexpected request ${q.method}`);
  const replacement=options.reply?.(q,result,store);if(replacement)return replacement;
  return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 };
 const client=api.loadClient(provider,store,{endpoint:'https://project.example/?api-key=secret-test-key',fetch,now:()=>time,pause:async()=>{}});
 return {client,store,provider,fetch,requests,urls,walletCalls:()=>walletCalls,setCount:n=>count=n};
}
for(const [label,api] of [['source',source],['shipped SDK',shipped]]){
 test(`${label}: read validates real 1950, resumes settings and never signs`,async()=>{
  const f=setup(api);assert.equal((await f.client.inspect()).progress.loaded,1950);assert.equal(f.walletCalls(),0);
  assert.deepEqual(f.requests.map(q=>q.method),['getGenesisHash','getAccountInfo']);
  assert.equal(f.store.read(LEGACY_KEY).retiredTo,api.KEY);
 });
 test(`${label}: one native Phantom call uploads exactly 25 and verifies 1975 automatically`,async()=>{
  const f=setup(api);const result=await f.client.upload();assert.equal(result.progress.loaded,1975);assert.equal(result.pending,false);assert.equal(result.lastAttempt.outcome,'account-verified');
  assert.equal(f.walletCalls(),1);assert.equal(f.requests.some(q=>q.method==='sendTransaction'||q.method==='getBlockHeight'),false);
  assert.deepEqual(f.requests.map(q=>q.method),['getGenesisHash','getAccountInfo','getLatestBlockhash','getAccountInfo']);
  assert.ok(f.urls.every(u=>u==='https://project.example/?api-key=secret-test-key'));assert.equal(f.client.backup().includes('secret-test-key'),false);
 });
 test(`${label}: slow wallet return is sent by Phantom and does not run the old expiry guard`,async()=>{
  const f=setup(api,{wallet:({setCount,setTime})=>{setCount(1975);setTime(58000);return {signature};}});
  assert.equal((await f.client.upload()).progress.loaded,1975);
  assert.equal(f.store.read(api.KEY).events.find(e=>e.phase==='wallet-return').elapsedMs,58000);
 });
 test(`${label}: unknown wallet response survives reload and cannot cause another signature`,async()=>{
  const f=setup(api,{wallet:()=>{throw Error('disconnected https://rpc/?api-key=secret-test-key');}});
  await assert.rejects(f.client.upload(),/Phantom/);assert.equal(f.store.read(api.KEY).pending.phase,'unknown');
  const recovered=api.loadClient(f.provider,f.store,{fetch:f.fetch,pause:async()=>{}});
  const r=await recovered.upload();assert.equal(r.pending,true);assert.equal(f.walletCalls(),1);assert.equal(recovered.backup().includes('secret-test-key'),false);
 });
 test(`${label}: cancellation is durable and does not create an unknown send`,async()=>{
  const f=setup(api,{wallet:()=>{throw Object.assign(Error('Rejected'),{code:4001});}});
  await assert.rejects(f.client.upload(),/отменено/);assert.equal(f.store.read(api.KEY).pending,null);assert.equal(f.store.read(api.KEY).lastAttempt.outcome,'cancelled');
  await f.client.inspect();assert.equal(f.store.read(api.KEY).lastAttempt.outcome,'cancelled');
 });
 test(`${label}: wallet -32603 preserves its redacted reason and checks finalized progress once`,async()=>{
  const reason=Object.assign(Error('Transaction too large: 1260 > 1232; https://rpc.example/?api-key=other-secret; key=secret-test-key'),{code:-32603,data:{message:'Minimum context slot has not been reached; "password":"short-secret"; token=another-secret'},cause:Error('Bearer private-token-value')});
  const f=setup(api,{wallet:()=>{throw reason;}});
  await assert.rejects(f.client.upload(),/32603/);
  const j=f.store.read(api.KEY),error=j.events.find(e=>e.phase==='wallet-error');
  assert.match(error.detail,/Transaction too large: 1260 > 1232/);assert.match(error.detail,/Minimum context slot/);
  assert.equal(j.pending.phase,'unknown');assert.deepEqual(j.pending.walletError,j.lastAttempt.walletError);
  assert.equal(j.events.find(e=>e.phase==='wallet-request').transactionBytes,1145);
  const reads=f.requests.filter(q=>q.method==='getAccountInfo');assert.equal(reads.length,2);assert.equal(reads[1].params[1].commitment,'finalized');assert.equal(f.walletCalls(),1);
  for(const secret of ['other-secret','secret-test-key','short-secret','another-secret','private-token-value','rpc.example'])assert.equal(f.client.backup().includes(secret),false,secret);
 });
 test(`${label}: lost wallet response after execution is recovered without another signature`,async()=>{
  const f=setup(api,{wallet:({setCount})=>{setCount(1975);throw Object.assign(Error('Unexpected error'),{code:-32603});}});
  const result=await f.client.upload();assert.equal(result.progress.loaded,1975);assert.equal(result.pending,false);assert.equal(result.lastAttempt.outcome,'account-verified');
  assert.equal(result.lastAttempt.walletError.code,-32603);assert.equal(f.walletCalls(),1);
  assert.equal(f.requests.filter(q=>q.method==='getAccountInfo').at(-1).params[1].commitment,'finalized');
 });
 test(`${label}: failed post-error check preserves unknown intent and original wallet reason`,async()=>{
  const f=setup(api,{wallet:()=>{throw Object.assign(Error('Preflight unavailable'),{code:-32603});},reply:q=>q.method==='getAccountInfo'&&f.walletCalls()?new Response('unavailable',{status:503}):null});
  await assert.rejects(f.client.upload(),/32603/);const j=f.store.read(api.KEY);
  assert.equal(j.pending.phase,'unknown');assert.equal(j.lastAttempt.walletError.detail,'Preflight unavailable');assert.equal(j.events.at(-1).phase,'wallet-error-verification');assert.equal(f.walletCalls(),1);
 });
 test(`${label}: documented Phantom rejections preserve the explanation and release only this unsent intent`,async()=>{
  for(const code of [4100,-32000,-32002,-32003,-32601]){
   const f=setup(api,{wallet:()=>{throw Object.assign(Error('provider error'),{code});}});
   await assert.rejects(f.client.upload(),/Phantom/);const j=f.store.read(api.KEY);
   assert.equal(j.pending,null);assert.equal(j.lastAttempt.outcome,'rejected');assert.ok(j.lastAttempt.message);
   await f.client.inspect();assert.equal(f.store.read(api.KEY).lastAttempt.message,j.lastAttempt.message);
  }
 });
 test(`${label}: no wallet invocation if durable intent cannot be saved`,async()=>{
  const store=memoryStore(),original=store.write;store.write=(k,v)=>{if(k===api.KEY&&v.pending)throw Error('disk full');original(k,v);};
  const f=setup(api,{store});await assert.rejects(f.client.upload(),/disk full/);assert.equal(f.walletCalls(),0);
 });
 test(`${label}: missing signature stays unknown; no auto retry even after original deadline`,async()=>{
  const f=setup(api,{wallet:()=>({})});const r=await f.client.upload();assert.equal(r.pending,true);
  assert.equal((await f.client.upload()).pending,true);assert.equal(f.walletCalls(),1);
 });
 test(`${label}: a failed final transaction can be cleared using real status, never guessed expiry`,async()=>{
  const f=setup(api,{wallet:()=>({signature}),reply:q=>q.method==='getSignatureStatuses'?new Response(JSON.stringify({result:{context:{slot:SLOT+10},value:[{confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']}}]}})):null});
  assert.equal((await f.client.upload()).pending,true);const checked=await f.client.inspect();assert.equal(checked.pending,false);assert.equal(checked.lastAttempt.outcome,'failed');assert.equal(f.walletCalls(),1);
 });
 test(`${label}: real legacy 250 journal recovers 7 completed + 3 expired, never signs`,async()=>{
  const old={version:1,...api.TARGET,pending:null,pendingGroup:phone.pendingGroup,history:[{original:true}]};
  const f=setup(api,{store:memoryStore([[LEGACY_KEY,old]])});const r=await f.client.upload();
  assert.equal(r.progress.loaded,1950);assert.equal(r.pending,false);assert.equal(f.walletCalls(),0);
  const j=f.store.read(api.KEY);assert.deepEqual(j.legacyArchive,old);assert.equal(j.history.filter(x=>x.outcome==='account-verified').length,7);assert.equal(j.history.filter(x=>x.outcome==='expired').length,3);
  assert.equal(j.legacyPending.length,0);assert.equal(f.store.read(LEGACY_KEY).version,2);
 });
 test(`${label}: live old signatures block native signing without erasing history`,async()=>{
  const old={version:1,...api.TARGET,pending: {...phone.pendingGroup[9],lastValidBlockHeight:1000000000},history:[]};
  const f=setup(api,{store:memoryStore([[LEGACY_KEY,old]])});assert.equal((await f.client.upload()).pending,true);assert.equal(f.walletCalls(),0);
 });
 test(`${label}: wrong network and wrong account stop before a wallet request`,async()=>{
  for(const method of ['getGenesisHash','getAccountInfo']){
   const f=setup(api,{reply:(q,r)=>q.method===method?new Response(JSON.stringify({result:method==='getGenesisHash'?'mainnet':{...r,value:{...r.value,owner:api.TARGET.owner}}})):null});
   await assert.rejects(f.client.upload());assert.equal(f.walletCalls(),0);assert.equal(f.store.read(LEGACY_KEY),null);
  }
 });
 test(`${label}: wallet switch during preparation cannot sign`,async()=>{
  let f;f=setup(api,{reply:q=>{if(q.method==='getLatestBlockhash')f.provider.publicKey=new PublicKey('11111111111111111111111111111111');}});
  await assert.rejects(f.client.upload(),/владельца/);assert.equal(f.walletCalls(),0);
 });
 test(`${label}: 429 fails once and records the real method without losing a sent attempt`,async()=>{
  const f=setup(api,{wallet:()=>({signature}),reply:q=>q.method==='getAccountInfo'&&f.walletCalls()?new Response('https://secret-key/',{status:429,headers:{'Retry-After':'30'}}):null});
  await assert.rejects(f.client.upload(),/ограничил/);assert.equal(f.walletCalls(),1);assert.equal(f.store.read(api.KEY).pending.signature,signature);
  await assert.rejects(f.client.inspect(),/ограничил/);assert.equal(f.walletCalls(),1);
  assert.equal(f.store.read(api.KEY).events.at(-1).outcome,429);assert.equal(f.client.backup().includes('secret-key'),false);
 });
 test(`${label}: concurrent clicks cannot open two Phantom dialogs`,async()=>{
  let resolve,entered;const reached=new Promise(r=>entered=r);const f=setup(api,{wallet:()=>{entered();return new Promise(r=>resolve=r);}});
  const first=f.client.upload();await reached;await assert.rejects(f.client.upload(),/locked/);resolve({signature});await first;assert.equal(f.walletCalls(),1);
 });
 test(`${label}: loaded 10000 needs neither blockhash nor signing`,async()=>{
  const f=setup(api);f.setCount(10000);assert.equal((await f.client.upload()).progress.loaded,10000);assert.equal(f.walletCalls(),0);
 });
}
test('RPC timeout bounds a hung fetch and keeps the endpoint secret',async()=>{
 const events=[];const rpc=readRpc('https://project.example/?api-key=key',{timeout:10,fetch:()=>new Promise(()=>{}),onEvent:e=>events.push(e)});
 await assert.rejects(rpc('getAccountInfo',[]),/10 секунд/);assert.equal(events[0].outcome,'timeout');assert.equal(JSON.stringify(events).includes('api-key'),false);
});
test('browser lock and failed storage write stop the operation',async()=>{
 const raw=new Map();const storage={getItem:k=>raw.get(k)??null,setItem:()=>{}};
 assert.throws(()=>source.browserStore(storage).write('x',{}),/сохранить/);
 assert.throws(()=>source.browserStore(storage,{}).lock(()=>{}),/блокировки/);
 await assert.rejects(source.browserStore(storage,{request:async(_,__,fn)=>fn(null)}).lock(()=>{}),/другой вкладке/);
});
test('old page has only a redirect; removed scripts cannot enter either public build',async()=>{
 const files=JSON.parse(await readFile('scripts/public-files.json','utf8'));
 assert.equal(files.some(f=>f.startsWith('solana-upload/')&&f!=='solana-upload/index.html'),false);
 const html=await readFile('solana-upload/index.html','utf8');assert.match(html,/url=\/solana-load\//);assert.doesNotMatch(html,/<script|sdk\.js|controller\.mjs/);
});
