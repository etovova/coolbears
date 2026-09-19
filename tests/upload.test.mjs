import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { some } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { createUploader, loadedItems } from '../solana/upload.mjs';
import { fileUploadStore } from '../solana/upload-store.mjs';
import { LAUNCH_OWNER } from '../solana/launch-plan.mjs';
import { configLineSettings, SITE } from '../solana/builders.mjs';
const target={cluster:'devnet',machine:'3cCPC8tECbbqj7j6HMLuPNF8ga8YVkrdwbRn15rjTjwu',collection:'7TBBVkBziGZxGp8a8Uhv6U27fpj8gLQJP2mFE4H19dj9'};
const item=i=>({index:i,minted:false,name:`CoolBears #${String(i).padStart(4,'0')} — Hidden Bear`,uri:`${SITE}/metadata/hidden/${String(i).padStart(4,'0')}.json`});
function fixture(){
 const machine={publicKey:target.machine,header:{owner:MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID},authority:LAUNCH_OWNER,collectionMint:target.collection,data:{itemsAvailable:10000n,isMutable:true,configLineSettings:some(configLineSettings)},itemsRedeemed:0n,itemsLoaded:0,items:[]};
 const f={machine,journal:null,sends:0,height:10,status:null,failSave:false,lost:false,applied:true,prepared:[]};
 f.store={read:async()=>structuredClone(f.journal),write:async(k,j)=>{if(f.failSave)throw Error('disk full');f.journal=structuredClone(j);},withLock:async(k,fn)=>fn()};
 f.transport={assertNetwork:async()=>{},snapshot:async()=>({machine,slot:100,height:f.height,signatureStatus:f.status}),prepare:async batch=>{f.prepared.push(batch);return {...batch,signature:base58.deserialize(new Uint8Array(64).fill(1))[0],lastValidBlockHeight:20};},broadcast:async p=>{assert.ok(f.journal.pending);f.sends++;if(f.applied){machine.items.push(...Array.from({length:p.count},(_,i)=>item(p.start+i)));machine.itemsLoaded=machine.items.length;}if(f.lost)throw Error('RPC response lost');}};
 f.run=()=>createUploader(f.transport,f.store,target).step();return f;
}
test('Lost response after successful send resumes from finalized account without duplicate broadcast',async()=>{
 const f=fixture();f.lost=true;await assert.rejects(f.run(),/lost/);assert.equal(f.sends,1);assert.ok(f.journal.pending);
 assert.equal((await f.run()).status,'verified');assert.equal(f.sends,1);
 f.lost=false;await f.run();assert.deepEqual(f.prepared[1],{start:25,count:25});
});
test('Unknown result blocks retries; expiry requires an extra explicit step; success status cannot be discarded',async()=>{
 const f=fixture();f.applied=false;await f.run();assert.equal((await f.run()).status,'pending');assert.equal(f.sends,1);
 f.height=21;f.status={confirmationStatus:'finalized',err:null};assert.equal((await f.run()).status,'pending');
 f.status=null;assert.equal((await f.run()).status,'retry-available');assert.equal(f.sends,1);await f.run();assert.equal(f.sends,2);
});
test('Storage failure forbids broadcast; malformed journals and wrong network fail closed',async()=>{
 const f=fixture();f.failSave=true;await assert.rejects(f.run(),/disk/);assert.equal(f.sends,0);
 f.failSave=false;f.transport.assertNetwork=async()=>{throw Error('network');};await assert.rejects(f.run(),/network/);assert.equal(f.sends,0);
});
test('Rejects foreign metadata, wrong collection, already minted machine and partial pending batch',async()=>{
 const f=fixture();f.machine.items=[item(0)];f.machine.itemsLoaded=1;f.machine.items[0].uri='wrong';assert.throws(()=>loadedItems(f.machine,target));
 f.machine.items[0]=item(0);assert.throws(()=>loadedItems({...f.machine,collectionMint:LAUNCH_OWNER},target));
 assert.throws(()=>loadedItems({...f.machine,itemsRedeemed:1n},target));
 f.machine.items=[];f.machine.itemsLoaded=0;f.applied=false;await f.run();f.machine.items=[item(0)];f.machine.itemsLoaded=1;await assert.rejects(f.run(),/Partial/);assert.equal(f.sends,1);
});
test('Loads 10000 items across restarts, verifies last batch, then completes without another send',async()=>{
 const f=fixture();for(let i=0;i<400;i++){assert.equal((await f.run()).status,'submitted');assert.equal((await f.run()).status,'verified');}
 assert.equal((await f.run()).status,'complete');assert.equal(f.sends,400);assert.equal(f.machine.itemsLoaded,10000);
});
test('Finds gaps without overwriting loaded items',async()=>{
 const f=fixture();f.machine.items=[item(0),item(2),item(3)];f.machine.itemsLoaded=3;
 await f.run();assert.deepEqual(f.prepared[0],{start:1,count:1});
});
test('File store preserves pending across reopen, rejects concurrent writer and releases lock on exception',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coolbears-upload-'));
 try {const a=fileUploadStore(dir),b=fileUploadStore(dir);await a.withLock('key',async()=>{
 await a.write('key',{pending:{signature:'saved'}});assert.deepEqual(await b.read('key'),{pending:{signature:'saved'}});
 await assert.rejects(b.withLock('key',async()=>{}),/locked/);
 });await assert.rejects(a.withLock('key',async()=>{throw Error('crash');}),/crash/);
 await b.withLock('key',async()=>{});assert.equal((await readdir(dir)).length,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('Umi transport checks genesis, wallet changes, expiry and preflight options',async()=>{
 const {devnetUmi}=await import('../solana/builders.mjs');
 const {launchPlan}=await import('../solana/launch-plan.mjs');
 const {umiUploadTransport,GENESIS}=await import('../solana/upload.mjs');
 const {signerIdentity,publicKey}=await import('@metaplex-foundation/umi');
 // Independent value recorded from the Devnet RPC, not the constant under test.
 let signed=0,expired=false,network='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
 const signTransaction=async tx=>{signed++;return {...tx,signatures:[new Uint8Array(64).fill(7)]};};
 const signer={publicKey:publicKey(LAUNCH_OWNER),signTransaction,signAllTransactions:async txs=>Promise.all(txs.map(signTransaction)),signMessage:async()=>new Uint8Array(64)};
 const umi=devnetUmi().use(signerIdentity(signer));let sent=0;
 umi.rpc.call=async method=>{
 if(method==='getGenesisHash')return network;
 if(method==='getLatestBlockhash')return {context:{slot:100},value:{blockhash:LAUNCH_OWNER,lastValidBlockHeight:20}};
 if(method==='getBlockHeight')return expired?21:10;
 throw Error(method);
 };
 umi.rpc.sendTransaction=async(tx,options)=>{assert.equal(options.skipPreflight,false);assert.equal(options.minContextSlot,100);sent++;};
 const t=umiUploadTransport(umi,launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER}),target);
 const p=await t.prepare({start:0,count:25},'devnet');await t.broadcast(p,'devnet');assert.equal(sent,1);
 expired=true;await assert.rejects(t.prepare({start:25,count:25},'devnet'),/expired/);assert.equal(sent,1);
 network=GENESIS['mainnet-beta'];await assert.rejects(t.prepare({start:25,count:25},'devnet'),/Сеть RPC/);assert.equal(signed,2);
 network=GENESIS.devnet;umi.identity={...signer,publicKey:publicKey(target.collection)};await assert.rejects(t.broadcast(p,'devnet'),/wallet/);assert.equal(sent,1);
});
