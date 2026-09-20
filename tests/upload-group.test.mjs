import {test} from 'node:test';
import assert from 'node:assert/strict';
import {some,publicKey,signerIdentity} from '@metaplex-foundation/umi';
import {base58} from '@metaplex-foundation/umi/serializers';
import {MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core-candy-machine';
import {createGroupUploader} from '../solana/upload-group.mjs';
import {createUploader,umiUploadTransport} from '../solana/upload.mjs';
import {runUpload} from '../solana/upload-runner.mjs';
import {pacedRpcFetch} from '../solana/rpc-pacing.mjs';
import {LAUNCH_OWNER,launchPlan} from '../solana/launch-plan.mjs';
import {configLineSettings,SITE,devnetUmi} from '../solana/builders.mjs';
const target={cluster:'devnet',machine:'FLpAJpBG7BDEL5cFZPiouGD6ZWnTWRRBrWxtkjVz9s3R',collection:'BZRkdsRsmeBBGb1JsVUbgZbThWraaMPSRazdiQdioLcy'};
const signature=i=>base58.deserialize(Uint8Array.from({length:64},(_,j)=>(i+j)%256))[0];
const item=i=>({index:i,minted:false,name:`CoolBears #${String(i).padStart(4,'0')} — Hidden Bear`,uri:`${SITE}/metadata/hidden/${String(i).padStart(4,'0')}.json`});
function fixture(n=1775){
 const machine={publicKey:target.machine,header:{owner:MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID},authority:LAUNCH_OWNER,collectionMint:target.collection,data:{itemsAvailable:10000n,isMutable:true,configLineSettings:some(configLineSettings)},itemsRedeemed:0n,itemsLoaded:n,items:Array.from({length:n},(_,i)=>item(i))};
 const f={machine,journal:null,height:10,groups:0,sends:[],apply:true,lost:false,failSave:false};
 f.store={read:async()=>structuredClone(f.journal),write:async(k,j)=>{if(f.failSave)throw Error('disk full');f.journal=structuredClone(j);},withLock:async(k,fn)=>fn()};
 f.transport={assertNetwork:async()=>{},snapshot:async p=>({machine,slot:100,height:f.height,signatureStatus:p.map(()=>f.status??null)}),prepareGroup:async batches=>{f.groups++;return batches.map((b,i)=>({...b,signature:signature(i+1),lastValidBlockHeight:20}));},broadcast:async p=>{
  assert.equal(f.journal.pendingGroup.length,f.expectedSize??10);f.sends.push(p.start);
  if(f.apply){machine.items.push(...Array.from({length:p.count},(_,i)=>item(p.start+i)));machine.itemsLoaded=machine.items.length;}
  if(f.lost)throw Error('response lost');
 }};
 f.step=options=>createGroupUploader(f.transport,f.store,target).step(options);return f;
}
test('Existing 1775 records resume in a group of ten, whole group persisted before first broadcast',async()=>{
 const f=fixture();assert.equal((await f.step()).status,'submitted');assert.deepEqual(f.sends,Array.from({length:10},(_,i)=>1775+i*25));
 assert.equal((await f.step({sign:false})).status,'verified');assert.equal(f.groups,1);assert.equal(f.journal.history.length,10);assert.equal(f.machine.itemsLoaded,2025);
});
test('Lost response and reload never resubmit uncertain signatures; expiry requires another explicit run',async()=>{
 const f=fixture();f.lost=true;assert.equal((await f.step()).status,'pending');assert.equal(f.sends.length,1);
 assert.equal((await f.step()).status,'pending');assert.equal(f.journal.history.length,1);assert.equal(f.journal.pendingGroup.length,9);
 f.height=21;f.status={confirmationStatus:'finalized',err:null};assert.equal((await f.step()).status,'pending');
 f.status=null;assert.equal((await f.step()).status,'retry-available');assert.equal(f.groups,1);assert.equal(f.sends.length,1);assert.equal(f.journal.history.filter(p=>p.outcome==='expired').length,9);
});
test('RPC timeout during broadcast keeps the whole journal and cannot replay the unknown send',async()=>{
 const f=fixture();
 const rpc=pacedRpcFetch({interval:0,timeout:15,fetch:async()=>new Promise(()=>{})});
 f.transport.broadcast=async p=>{assert.equal(f.journal.pendingGroup.length,10);f.sends.push(p.start);await rpc.fetch('rpc');};
 assert.equal((await f.step()).status,'pending');
 const journal=structuredClone(f.journal);
 assert.equal((await f.step()).status,'pending');
 assert.equal(f.groups,1);assert.equal(f.sends.length,1);assert.deepEqual(f.journal,journal);
});
test('Old single pending migrates and old uploader refuses unresolved group',async()=>{
 const f=fixture(25);f.journal={version:1,...target,owner:LAUNCH_OWNER,history:[],pending:{start:0,count:25,signature:signature(1),lastValidBlockHeight:20}};
 assert.equal((await f.step()).status,'verified');assert.equal(f.groups,0);assert.equal(f.journal.pending,null);
 await f.step();await assert.rejects(createUploader(f.transport,f.store,target).step(),/групповую/);
});
test('Storage failure, cancellation, malformed and partially applied groups prevent new broadcasts',async()=>{
 const f=fixture();f.failSave=true;await assert.rejects(f.step(),/disk/);assert.equal(f.sends.length,0);
 f.failSave=false;await f.step({stopped:()=>true});assert.equal(f.sends.length,0);
 f.apply=false;await f.step();const sent=f.sends.length;f.machine.items.push(item(1775));f.machine.itemsLoaded++;
 await assert.rejects(f.step(),/Partial/);assert.equal(f.sends.length,sent);
 f.journal.pendingGroup[1].start=1775;await assert.rejects(f.step(),/Overlapping/);
});
test('Manual runner reconciles one 25-record group per explicit button press',async()=>{
 const f=fixture(9975);f.expectedSize=1;
 const first=await runUpload({groupStep:f.step},{size:1});
 assert.equal(first.status,'submitted');assert.equal(f.sends.length,1);assert.equal(f.groups,1);
 const second=await runUpload({groupStep:f.step},{size:1});
 assert.equal(second.status,'complete');assert.equal(f.sends.length,1);assert.equal(f.groups,1);assert.equal(f.machine.itemsLoaded,10000);
});
test('Runner never waits, retries, or signs a second group automatically',async()=>{
 let calls=0,slept=0;
 const pending=await runUpload({groupStep:async options=>{calls++;assert.equal(options.sign,true);return {status:'pending',loaded:1775};}},{size:1,sleep:async ms=>{slept+=ms;}});
 assert.equal(pending.status,'pending');assert.equal(calls,1);assert.equal(slept,0);
});
test('Real Umi group builder calls signAll once, rejects changed messages and expired signatures',async()=>{
 let calls=0,mode='ok',height=10;
 const signer={publicKey:publicKey(LAUNCH_OWNER),signMessage:async()=>new Uint8Array(64),signTransaction:async()=>{throw Error('must group');},signAllTransactions:async txs=>{calls++;return txs.map((tx,i)=>{if(mode==='changed')tx.serializedMessage[0]^=1;return {...tx,signatures:[new Uint8Array(64).fill(i+1)]};});}};
 const umi=devnetUmi().use(signerIdentity(signer));
 umi.rpc.call=async method=>{if(method==='getGenesisHash')return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';if(method==='getLatestBlockhash')return {context:{slot:100},value:{blockhash:LAUNCH_OWNER,lastValidBlockHeight:20}};if(method==='getBlockHeight')return height;throw Error(method);};
 const t=umiUploadTransport(umi,launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER}),target);
 const batches=Array.from({length:10},(_,i)=>({start:1775+i*25,count:25}));
 const p=await t.prepareGroup(batches,'devnet');assert.equal(p.length,10);assert.equal(calls,1);assert.equal(new Set(p.map(x=>x.signature)).size,10);
 mode='changed';await assert.rejects(t.prepareGroup(batches,'devnet'),/изменил/);
 mode='ok';height=21;await assert.rejects(t.prepareGroup(batches,'devnet'),/истёк/);
});
test('Manual runner sends only one group per invocation without duplicates',async()=>{
 const f=fixture();f.expectedSize=1;
 const r=await runUpload({groupStep:f.step},{size:1});
 assert.equal(r.status,'submitted');assert.equal(f.groups,1);assert.equal(f.sends.length,1);assert.equal(f.sends[0],1775);
 assert.equal(f.journal.pendingGroup.length,1);assert.equal(f.journal.pendingGroup[0].count,25);
});
test('Wallet rejection and stop while signing never broadcast or create pending entries',async()=>{
 const f=fixture();f.transport.prepareGroup=async()=>{throw Error('User rejected');};
 await assert.rejects(f.step(),/rejected/);assert.equal(f.journal,null);assert.equal(f.sends.length,0);
 let stopped=false;f.transport.prepareGroup=async b=>{stopped=true;return b.map((p,i)=>({...p,signature:signature(i+1),lastValidBlockHeight:20}));};
 assert.equal((await f.step({stopped:()=>stopped})).status,'stopped');assert.equal(f.journal,null);assert.equal(f.sends.length,0);
});
