import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PublicKey} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import * as source from '../solana/upload-client.mjs';
import * as published from '../solana-upload/sdk.js';
import {pacedRpcFetch} from '../solana/rpc-pacing.mjs';

// Public finalized account captured by getAccountInfo. No wallet secrets or
// signed transaction bytes are included. Run both source and shipped bundle.
const fixture=JSON.parse(await readFile(new URL('./fixtures/upload-machine-1950.json',import.meta.url),'utf8'));
fixture.result.value.data=[gunzipSync(Buffer.from(fixture.result.value.data[0],'base64')).toString('base64'),'base64'];
const owner='FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
const state={owner,cluster:'devnet',collection:'BZRkdsRsmeBBGb1JsVUbgZbThWraaMPSRazdiQdioLcy',machine:fixture.machine};
const key=`coolbears-upload-v1:devnet:${state.machine}`;
function setup(api,journal,config={}){
 const saved=new Map([[api.SETUP_KEY,structuredClone(state)],[key,journal]]),locks=new Set(),requests=[];
 let signs=0,sends=0;
 const store={read:k=>structuredClone(saved.get(k)??null),write:(k,v)=>saved.set(k,structuredClone(v)),withLock:async(k,fn)=>{
  assert.equal(locks.has(k),false);locks.add(k);try{return await fn();}finally{locks.delete(k);}
 }};
 const provider={publicKey:new PublicKey(owner),signAllTransactions:()=>{throw Error('group signing forbidden');},signTransaction:async tx=>{
  signs++;tx.signatures[0]=new Uint8Array(64).fill(9);assert.ok(tx.serialize().length<=1232);return tx;
 }};
 const fetch=async(_url,options)=>{
  const q=JSON.parse(options.body);requests.push(q);
  const slot=fixture.result.context.slot;let result;
  if(q.method==='getAccountInfo'){assert.equal(q.params[0],state.machine);result=fixture.result;}
  else if(q.method==='getGenesisHash')result='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  else if(q.method==='getLatestBlockhash')result={context:{slot},value:{blockhash:owner,lastValidBlockHeight:1000}};
  else if(q.method==='getBlockHeight')result=100;
  else if(q.method==='getEpochInfo')result={absoluteSlot:slot,blockHeight:100};
  else if(q.method==='getSignatureStatuses')result={context:{slot},value:q.params[0].map(()=>null)};
  else if(q.method==='sendTransaction'){
   assert.ok(saved.get(key).pendingGroup?.length===1);assert.equal(saved.get(key).pendingGroup[0].start,1950);assert.equal(saved.get(key).pendingGroup[0].count,25);
   assert.notEqual(q.params[1].skipPreflight,true);sends++;result=base58.deserialize(new Uint8Array(64).fill(9))[0];
  }else throw Error(`Unexpected RPC: ${q.method}`);
  return config.reply?.(q,result)??new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 };
 const paced=config.paced?pacedRpcFetch({fetch,fallbackEndpoints:['https://api.devnet.solana.com']}):{fetch};
 return {client:api.uploadClient(provider,store,{paced}),requests,saved,signs:()=>signs,sends:()=>sends};
}
for(const [name,api] of [['source',source],['published bundle',published]]){
 test(`${name}: real account decoder validates 1950 records using exactly one read`,async()=>{
  const f=setup(api);const result=await f.client.read();assert.equal(result.loaded,1950);assert.equal(result.machine,true);
  assert.deepEqual(f.requests.map(q=>q.method),['getAccountInfo']);assert.equal(f.requests[0].params[1].commitment,'confirmed');
  assert.equal(f.signs(),0);assert.equal(f.sends(),0);
 });
 test(`${name}: one click requests one signature for 1950..1974, pending cannot be sent again`,async()=>{
  const f=setup(api);const first=await api.runUpload(f.client);assert.equal(first.status,'submitted');assert.equal(f.signs(),1);assert.equal(f.sends(),1);
  assert.equal((await api.runUpload(f.client)).status,'pending');assert.equal(f.signs(),1);assert.equal(f.sends(),1);
 });
 test(`${name}: legacy 250-record journal is reconciled without any new signing`,async()=>{
  const pendingGroup=Array.from({length:10},(_,i)=>({start:1775+i*25,count:25,signature:base58.deserialize(new Uint8Array(64).fill(i+1))[0],lastValidBlockHeight:90}));
  const f=setup(api,{version:1,...state,history:[],pending:null,pendingGroup});
  const result=await api.runUpload(f.client);assert.equal(result.loaded,1950);assert.equal(result.status,'retry-available');
  assert.equal(f.signs(),0);assert.equal(f.sends(),0);assert.equal(f.saved.get(key).history.filter(r=>r.outcome==='account-verified').length,7);
  assert.equal(f.saved.get(key).history.filter(r=>r.outcome==='expired').length,3);assert.equal(f.saved.get(key).pendingGroup.length,0);
  assert.equal(f.requests.find(q=>q.method==='getSignatureStatuses').params[0].length,3);
  assert.equal(f.requests.find(q=>q.method==='getAccountInfo').params[1].minContextSlot,fixture.result.context.slot);
 });
 test(`${name}: applied packet verifies without any block or signature-history request`,async()=>{
  const pending={start:1925,count:25,signature:base58.deserialize(new Uint8Array(64).fill(1))[0],lastValidBlockHeight:90};
  const f=setup(api,{version:1,...state,history:[],pending});
  assert.equal((await api.runUpload(f.client)).status,'verified');
  assert.deepEqual(f.requests.map(q=>q.method),['getGenesisHash','getEpochInfo','getAccountInfo']);
  assert.equal(f.saved.get(key).history[0].outcome,'account-verified');assert.equal(f.signs(),0);assert.equal(f.sends(),0);
 });
 test(`${name}: stale expiry/status evidence cannot clear the pending journal`,async()=>{
  const journal={version:1,...state,history:[],pending:{start:1950,count:25,signature:base58.deserialize(new Uint8Array(64).fill(1))[0],lastValidBlockHeight:90}};
  for(const method of ['getEpochInfo','getSignatureStatuses']){
   const f=setup(api,journal,{reply:(q,result)=>q.method===method?new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:method==='getEpochInfo'?{absoluteSlot:-1,blockHeight:100}:{context:{slot:fixture.result.context.slot-1},value:[null]}})):undefined});
   await assert.rejects(api.runUpload(f.client),/expiry|Stale/);assert.deepEqual(f.saved.get(key),journal);assert.equal(f.signs(),0);assert.equal(f.sends(),0);
  }
 });
 test(`${name}: an actual SDK RPC 429 records the failing method without signing or clearing pending`,async()=>{
  const journal={version:1,...state,history:[],pending:{start:1950,count:25,signature:base58.deserialize(new Uint8Array(64).fill(1))[0],lastValidBlockHeight:90}};
  const f=setup(api,journal,{paced:true,reply:q=>q.method==='getSignatureStatuses'?new Response('limited',{status:429,headers:{'Retry-After':'45'}}):undefined});
  const result=await api.runUpload(f.client);assert.equal(result.status,'rate-limited');assert.equal(result.rpc.method,'getSignatureStatuses');
  assert.deepEqual(f.saved.get(key),journal);assert.equal(f.signs(),0);assert.equal(f.sends(),0);
  const backup=JSON.parse(f.client.backup());assert.equal(backup.rpc.at(-1).outcome,429);assert.equal(backup.rpc.at(-1).method,'getSignatureStatuses');
 });

}
