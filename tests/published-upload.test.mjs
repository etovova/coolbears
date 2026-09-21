import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {PublicKey} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import * as source from '../solana/upload-client.mjs';
import * as published from '../solana-upload/sdk.js';

// Public finalized account captured by getAccountInfo. No wallet secrets or
// signed transaction bytes are included. Run both source and shipped bundle.
const fixture=JSON.parse(await readFile(new URL('./fixtures/upload-machine-1950.json',import.meta.url),'utf8'));
fixture.result.value.data=[gunzipSync(Buffer.from(fixture.result.value.data[0],'base64')).toString('base64'),'base64'];
const owner='FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
const state={owner,cluster:'devnet',collection:'BZRkdsRsmeBBGb1JsVUbgZbThWraaMPSRazdiQdioLcy',machine:fixture.machine};
const key=`coolbears-upload-v1:devnet:${state.machine}`;
function setup(api,journal){
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
  else if(q.method==='getSlot')result=slot;
  else if(q.method==='getBlock')result={blockHeight:100};
  else if(q.method==='getSignatureStatuses')result={context:{slot},value:q.params[0].map(()=>null)};
  else if(q.method==='sendTransaction'){
   assert.ok(saved.get(key).pendingGroup?.length===1);assert.equal(saved.get(key).pendingGroup[0].start,1950);assert.equal(saved.get(key).pendingGroup[0].count,25);
   assert.notEqual(q.params[1].skipPreflight,true);sends++;result=base58.deserialize(new Uint8Array(64).fill(9))[0];
  }else throw Error(`Unexpected RPC: ${q.method}`);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 };
 return {client:api.uploadClient(provider,store,{paced:{fetch}}),requests,saved,signs:()=>signs,sends:()=>sends};
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
 });
}
