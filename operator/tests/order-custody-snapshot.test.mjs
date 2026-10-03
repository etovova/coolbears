// Read-only IDB protocol double plus real native Ed25519 and SDK messages.
// Actual IndexedDB, restart and browser behavior are covered by the Chromium suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import policy from '../../metadata/policy.json' with {type:'json'};
import { createBuyerStorage } from '../orders/browser-storage.mjs';
import { createOrderModel } from '../orders/journal-model.mjs';
import { createOrderPlanner } from '../orders/transaction-model.mjs';
import { prepareAssetClaim, finalizeAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from '../orders/signing.mjs';

const model = createOrderModel(policy), planner = createOrderPlanner(model);
const native = globalThis.crypto, buyer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const address = n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const scopeFields = ['id','cluster','buyer','machine','collection','guard'];
globalThis.IDBKeyRange ??= {bound:(lower,upper)=>({lower,upper})};

async function fixture({phase='signed',quantity=2}={}) {
  const scope = {id:'custody-snapshot',cluster:'devnet',buyer:buyer.publicKey.toBase58(),machine:address(2),collection:address(3),guard:address(4)};
  const scopeKey = JSON.stringify(Object.fromEntries(scopeFields.map(field => [field,scope[field]])));
  const keys = [];
  for (let index=0; index<quantity; index++) {
    const pair = await native.subtle.generateKey('Ed25519',false,['sign','verify']);
    const asset = base58.deserialize(new Uint8Array(await native.subtle.exportKey('raw',pair.publicKey)))[0];
    keys.push({version:1,scopeKey,index,asset,...pair});
  }
  let order = model.createOrder({...scope,quantity,available:9999,assets:keys.map(key=>key.asset)});
  const events = [{type:'create',order:structuredClone(order)}], signing = [];
  if (phase!=='fresh') {
    const block = {blockhash:address(5),lastValidBlockHeight:2000};
    const template = planner.buildOrderTransactions(order,block).templates[0];
    const prepared = prepareAssetClaim(order,{orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(template.unsignedBytes).toString('base64')});
    order = prepared.order; events.push(prepared.event); signing.push({phase:'claimed',record:prepared.claim});
    if (phase!=='claimed') {
      const message = VersionedTransaction.deserialize(template.unsignedBytes).message.serialize();
      const signature = new Uint8Array(await native.subtle.sign('Ed25519',keys[0].privateKey,message));
      const request = finalizeAssetRequest(order,prepared.claim,signature);
      signing.push({phase:'ready',record:request});
      if (phase!=='ready') {
        const unknown = {type:'unknown',revision:order.revision,index:0,attempt:1};
        order=model.transitionOrder(order,unknown);events.push(unknown);
        const claimId='a'.repeat(64);
        signing.push({phase:'wallet-claimed',record:{version:1,claimId,requestId:buyerRequestId(request),orderRevision:order.revision}});
        if (phase!=='wallet') {
          const tx=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));tx.sign([buyer]);
          const transactionBase64=Buffer.from(tx.serialize()).toString('base64');
          const verified=verifyBuyerSigningResponse(order,prepared.claim,request,{transactionBase64});
          const event={type:'signature',revision:order.revision,index:0,attempt:1,signature:verified.signature,messageSha256:verified.messageSha256};
          order=model.transitionOrder(order,event);events.push(event);
          signing.push({phase:'buyer-response',record:{version:1,claimId,orderRevision:order.revision,transactionBase64,
            signature:verified.signature,messageSha256:verified.messageSha256}});
        }
      }
    }
  }
  const data={orders:order,keys,events,signing},calls={modes:[],transactionSigns:0,keyGeneration:0};
  let unusable=false;
  const crypto={getRandomValues:native.getRandomValues.bind(native),subtle:new Proxy(native.subtle,{get(target,name){
    if(name==='generateKey')return()=>{calls.keyGeneration++;assert.fail('recovery must never generate keys');};
    if(name==='sign')return async(...args)=>{
      if(new Uint8Array(args[2])[0]===128){calls.transactionSigns++;assert.fail('recovery must never sign transactions');}
      if(unusable)throw Error('fixture native key unavailable');
      return target.sign(...args);
    };
    return typeof target[name]==='function'?target[name].bind(target):target[name];
  }})};
  const db={close(){},transaction(names,mode){
    assert.deepEqual(names,['orders','keys','events','signing']);calls.modes.push(mode);
    assert.equal(mode,'readonly','recovery/custody failure must never begin a write');
    let pending=0,aborted=false;
    const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){
      const query=key=>{
        assert.equal(name==='orders'?key:key.lower[0],scopeKey);
        pending++;const request={};queueMicrotask(()=>{
          if(aborted)return;
          request.result=structuredClone(data[name]);request.onsuccess?.();
          if(--pending===0)queueMicrotask(()=>{if(!aborted)tx.oncomplete?.();});
        });return request;
      };
      return {get:query,getAll:query};
    }};return tx;
  }};
  const indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
  const locks={request:async(name,options,callback)=>{
    assert.equal(name,`coolbears:buyer-order:v1:${scopeKey}`);assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return callback({name});
  }};
  return {scope,data,calls,storage:createBuyerStorage({indexedDB,crypto,locks}),unusable:()=>{unusable=true;}};
}

test('complete recovery snapshot exposes canonical signed evidence and custody diagnostics without keys or writes',async()=>{
  const f=await fixture(),before=structuredClone(f.data),snapshot=await f.storage.readRecoverySnapshot(f.scope);
  assert.equal(snapshot.mode,'read-only-recovery');assert.equal(snapshot.readOnly,true);
  assert.deepEqual(snapshot.order,before.orders);assert.equal(snapshot.custody.status,'available');assert.equal(snapshot.custody.code,null);
  assert.equal(snapshot.custody.items.length,2);assert.ok(snapshot.custody.items.every(item=>item.status==='available'&&item.code===null));
  assert.deepEqual(snapshot.submission.input.response,{transactionBase64:before.signing[3].record.transactionBase64});
  assert.equal(snapshot.assetSigning.status,'asset-partial-saved');assert.equal(snapshot.buyerWallet.status,'buyer-response-saved');
  assert.equal(snapshot.responseRecovery,null);assert.equal(snapshot.prewalletRecovery,null);
  for(const field of ['readyToSign','readyToSubmit','retryAuthorized','salesOpen'])assert.equal(snapshot[field],false);
  assert.equal(snapshot.transactionsSent,0);assert.ok(!JSON.stringify(snapshot).includes('privateKey'));
  snapshot.order.id='caller-mutated';snapshot.submission.input.request.transactionBase64='caller-mutated';
  assert.deepEqual(f.data,before);assert.equal(f.calls.transactionSigns,0);assert.equal(f.calls.keyGeneration,0);assert.deepEqual(f.calls.modes,['readonly']);
});

test('missing later custody leaves exact first-attempt evidence readable while normal APIs fail closed',async()=>{
  const f=await fixture();f.data.keys.pop();const before=structuredClone(f.data);
  const snapshot=await f.storage.readRecoverySnapshot(f.scope);
  assert.equal(snapshot.custody.status,'unavailable');assert.equal(snapshot.custody.code,'ASSET_KEY_MISSING');
  assert.deepEqual(snapshot.custody.items.map(item=>item.status),['available','unavailable']);
  assert.equal(snapshot.submission.input.response.transactionBase64,before.signing[3].record.transactionBase64);
  for(const [method,arg]of [['read'],['readAssetSigning'],['recoverAssetSigning'],['readBuyerResponse'],['readBuyerSubmission'],
    ['readBuyerResponseRecovery'],['readPrewalletRecovery'],['readBuyerAttempt',1],['append',{type:'pause',revision:f.data.orders.revision}],
    ['prepareAssetSigning',{}],['claimBuyerWallet',{}],['claimBuyerSubmission',{}],['saveBuyerProof',{}]])
    await assert.rejects(f.storage[method](f.scope,arg),/ASSET_KEY_MISSING/,method);
  assert.deepEqual(f.data,before);assert.ok(f.calls.modes.every(mode=>mode==='readonly'));assert.equal(f.calls.transactionSigns,0);
});

test('missing first key is diagnosed separately from surviving later keys',async()=>{
  const f=await fixture();f.data.keys.shift();
  const snapshot=await f.storage.readRecoverySnapshot(f.scope);
  assert.deepEqual(snapshot.custody.items.map(item=>[item.status,item.code]),[['unavailable','ASSET_KEY_MISSING'],['available',null]]);
  assert.equal(snapshot.submission.status,'ready');assert.equal(snapshot.readyToSubmit,false);
});

test('invalid, mismatched and unusable retained keys remain unavailable without evidence changes or regeneration',async()=>{
  for(const [damage,code]of [
    [f=>{f.data.keys[0].privateKey={};},'INVALID_ASSET_KEY'],
    [f=>{f.data.keys[0].privateKey=f.data.keys[1].privateKey;},'ASSET_KEY_MISMATCH'],
    [f=>{f.data.keys[0].publicKey=f.data.keys[1].publicKey;},'ASSET_KEY_MISMATCH'],
    [f=>f.unusable(),'ASSET_KEY_MISMATCH'],
  ]){
    const f=await fixture();damage(f);const before=structuredClone(f.data);
    const snapshot=await f.storage.readRecoverySnapshot(f.scope);
    assert.equal(snapshot.custody.status,'unavailable');assert.equal(snapshot.custody.items[0].code,code);
    assert.equal(snapshot.submission.input.response.transactionBase64,before.signing[3].record.transactionBase64);
    await assert.rejects(f.storage.read(f.scope),new RegExp(code));assert.deepEqual(f.data,before);
    assert.equal(f.calls.keyGeneration,0);assert.equal(f.calls.transactionSigns,0);
  }
});

test('lost custody cannot downgrade corrupt order, event, claim, request or buyer response evidence',async()=>{
  for(const damage of [
    f=>{f.data.orders.id='different';},
    f=>{f.data.events.splice(1,1);},
    f=>{f.data.events[1].messageSha256='0'.repeat(64);},
    f=>{f.data.signing=[];},
    f=>{f.data.signing.shift();},
    f=>{f.data.signing[0].record.messageSha256='0'.repeat(64);},
    f=>{f.data.signing[1].record.transactionBase64='AAAA';},
    f=>{f.data.signing.splice(2,1);},
    f=>{f.data.signing[3].record.transactionBase64='AAAA';},
  ]){
    const f=await fixture();f.data.keys=[];damage(f);const before=structuredClone(f.data);
    await assert.rejects(f.storage.readRecoverySnapshot(f.scope));assert.deepEqual(f.data,before);assert.equal(f.calls.transactionSigns,0);
  }
});

test('missing partial and wallet response expose only their existing canonical recovery input',async()=>{
  for(const phase of ['claimed','ready','wallet']){
    const f=await fixture({phase});f.data.keys=[];const snapshot=await f.storage.readRecoverySnapshot(f.scope);
    assert.equal(snapshot.submission,null);assert.equal(snapshot.custody.status,'unavailable');
    if(phase==='wallet'){
      assert.equal(snapshot.prewalletRecovery,null);assert.equal(snapshot.responseRecovery.status,'wallet-response-unknown');
      assert.deepEqual(snapshot.responseRecovery.input.walletClaim,f.data.signing[2].record);
    }else{
      assert.equal(snapshot.responseRecovery,null);assert.equal(snapshot.prewalletRecovery.status,'prewallet-unknown');
      assert.deepEqual(snapshot.prewalletRecovery.input.request,phase==='ready'?f.data.signing[1].record:null);
    }
  }
});

test('fresh missing-key order has no invented attempt and only a wholly absent scope returns null',async()=>{
  const f=await fixture({phase:'fresh'});f.data.keys=[];
  const snapshot=await f.storage.readRecoverySnapshot(f.scope);
  for(const field of ['assetSigning','buyerWallet','submission','responseRecovery','prewalletRecovery'])assert.equal(snapshot[field],null);
  assert.ok(snapshot.order.items.every(item=>item.attempts.length===0));
  delete f.data.orders;
  await assert.rejects(f.storage.readRecoverySnapshot(f.scope),/ORPHANED_ORDER_DATA/);
  f.data.events=[];assert.equal(await f.storage.readRecoverySnapshot(f.scope),null);
  assert.equal(f.calls.keyGeneration,0);assert.equal(f.calls.transactionSigns,0);
});
