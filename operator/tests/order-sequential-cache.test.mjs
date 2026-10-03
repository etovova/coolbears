// Read-only IDB protocol double, real native custody and actual SDK signatures.
// Verifies cache invalidation; this does not claim actual browser IndexedDB coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createBuyerStorage} from '../orders/browser-storage.mjs';
import {createOrderModel} from '../orders/journal-model.mjs';
import {submissionBinding} from '../orders/submission.mjs';
import {expiryRecord} from '../orders/expiry-review.mjs';
import {replacementFor,replacementCandidate} from '../orders/replacement.mjs';
import {preparationFor} from '../orders/preparation.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse,buyerRequestId} from '../orders/signing.mjs';
const model=createOrderModel(policy),native=globalThis.crypto,buyer=Keypair.fromSeed(new Uint8Array(32).fill(61));
const address=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const scopeFields=['id','cluster','buyer','machine','collection','guard'];
globalThis.IDBKeyRange??={bound:(lower,upper)=>({lower,upper})};
async function fixture(){
  const scope={id:'sequential-cache',cluster:'devnet',buyer:buyer.publicKey.toBase58(),machine:address(62),collection:address(63),guard:address(64)};
  const scopeKey=JSON.stringify(Object.fromEntries(scopeFields.map(field=>[field,scope[field]]))),keys=[];
  for(let index=0;index<2;index++){
    const pair=await native.subtle.generateKey('Ed25519',false,['sign','verify']);
    const asset=base58.deserialize(new Uint8Array(await native.subtle.exportKey('raw',pair.publicKey)))[0];
    keys.push({version:1,scopeKey,index,asset,...pair});
  }
  let order=model.createOrder({...scope,quantity:2,available:9999,assets:keys.map(key=>key.asset)});
  const events=[{type:'create',order:structuredClone(order)}],signing=[],states={};
  const snapshot=name=>states[name]=structuredClone({orders:order,keys,events,signing});
  const transition=event=>{order=model.transitionOrder(order,event);events.push(event);};
  snapshot('fresh');
  for(let index=0;index<2;index++){
    const block={blockhash:address(65+index),lastValidBlockHeight:2000+index*1000},prepared=prepareAssetClaim(order,preparationFor(order,block,600+index*1000).candidate),claim=prepared.claim;
    order=prepared.order;events.push(prepared.event);signing.push({phase:'claimed',record:claim});snapshot(`claimed${index}`);
    const message=VersionedTransaction.deserialize(Buffer.from(claim.transactionBase64,'base64')).message.serialize();
    const request=finalizeAssetRequest(order,claim,new Uint8Array(await native.subtle.sign('Ed25519',keys[index].privateKey,message)));
    signing.push({phase:'ready',record:request});snapshot(`ready${index}`);
    transition({type:'unknown',revision:order.revision,index,attempt:1});
    const claimId=String(index+1).repeat(64);
    signing.push({phase:'wallet-claimed',record:{version:1,claimId,requestId:buyerRequestId(request),orderRevision:order.revision}});snapshot(`wallet${index}`);
    const tx=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));tx.sign([buyer]);
    const transactionBase64=Buffer.from(tx.serialize()).toString('base64'),checked=verifyBuyerSigningResponse(order,claim,request,{transactionBase64});
    transition({type:'signature',revision:order.revision,index,attempt:1,signature:checked.signature,messageSha256:checked.messageSha256});
    signing.push({phase:'buyer-response',record:{version:1,claimId,orderRevision:order.revision,transactionBase64,signature:checked.signature,messageSha256:checked.messageSha256}});snapshot(`signed${index}`);
    const number=String(index+1).padStart(4,'0'),proof={kind:'verified',cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,
      asset:claim.asset,blockhash:claim.blockhash,messageSha256:claim.messageSha256,commitment:'finalized',slot:700+index*1000,signature:checked.signature,accountSlot:800+index*1000,
      account:{program:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',owner:order.buyer,collection:order.collection,name:policy.hiddenName.replace('{index:04d}',number),uri:policy.website+'/metadata/hidden/'+number+'.json'}};
    transition({type:'reconcile',revision:order.revision,index,attempt:1,proof});snapshot(`verified${index}`);
  }
  const data=structuredClone(states.signed1),calls={modes:[],custodySigns:0,transactionSigns:0,keyGeneration:0};let unusable=false;
  const crypto={getRandomValues:native.getRandomValues.bind(native),subtle:new Proxy(native.subtle,{get(target,name){
    if(name==='generateKey')return()=>{calls.keyGeneration++;assert.fail('cache validation must not generate custody');};
    if(name==='sign')return async(...args)=>{if(new Uint8Array(args[2])[0]===128){calls.transactionSigns++;assert.fail('cache validation must not sign a transaction');}
      calls.custodySigns++;if(unusable)throw Error('unusable test custody');return target.sign(...args);};
    return typeof target[name]==='function'?target[name].bind(target):target[name];
  }})};
  const db={close(){},transaction(names,mode){
    assert.deepEqual(names,['orders','keys','events','signing']);calls.modes.push(mode);assert.equal(mode,'readonly','negative checks must fail before writes');
    let pending=0,aborted=false;const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){
      const query=key=>{assert.equal(name==='orders'?key:key.lower[0],scopeKey);pending++;const request={};queueMicrotask(()=>{
        if(aborted)return;request.result=structuredClone(data[name]);request.onsuccess?.();if(--pending===0)queueMicrotask(()=>{if(!aborted)tx.oncomplete?.();});
      });return request;};return{get:query,getAll:query};}};return tx;
  }};
  const indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
  const locks={request:async(name,options,callback)=>{assert.equal(name,`coolbears:buyer-order:v1:${scopeKey}`);assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return callback({name});}};
  return{scope,data,states,calls,storage:createBuyerStorage({indexedDB,crypto,locks}),use:name=>Object.assign(data,structuredClone(states[name])),unusable:value=>{unusable=value;}};
}
async function warm(f){assert.equal((await f.storage.readRecoverySnapshot(f.scope)).custody.status,'available');assert.deepEqual(await f.storage.read(f.scope),f.data.orders);}

test('successive two-item prefixes and exact repeated snapshots remain readable while native custody is reproved',async()=>{
  const f=await fixture();
  for(const phase of ['fresh','claimed0','ready0','wallet0','signed0','verified0','claimed1','ready1','wallet1','signed1','verified1']){
    f.use(phase);await warm(f);const count=f.calls.custodySigns;
    const read=await f.storage.readRecoverySnapshot(f.scope);assert.equal(f.calls.custodySigns,count+2);
    assert.deepEqual(read.order,f.data.orders);assert.equal(read.order.revision,f.data.events.length-1);
  }
  assert.equal((await f.storage.readCostSummary(f.scope)).verified,2);
  assert.equal(f.calls.keyGeneration,0);assert.equal(f.calls.transactionSigns,0);
});

test('warming exact canonical evidence never caches available custody or enables a mutable path after key loss',async()=>{
  for(const damage of [f=>f.data.keys.pop(),f=>{f.data.keys[0].privateKey=f.data.keys[1].privateKey;},f=>f.unusable(true)]){
    const f=await fixture();await warm(f);const original=structuredClone(f.data);damage(f);
    const snapshot=await f.storage.readRecoverySnapshot(f.scope);assert.equal(snapshot.custody.status,'unavailable');assert.deepEqual(snapshot.order,original.orders);
    assert.deepEqual(snapshot.submission.input.response,{transactionBase64:original.signing[7].record.transactionBase64});
    for(const [method,arg]of [['read'],['readBuyerSubmission'],['readAssetSigning'],['append',{type:'pause',revision:f.data.orders.revision}],['prepareAssetSigning',{}],['claimBuyerSubmission',{}]])
      await assert.rejects(f.storage[method](f.scope,arg),/ASSET_KEY_MISSING|ASSET_KEY_MISMATCH/,method);
    Object.assign(f.data,original);f.unusable(false);await warm(f);assert.equal(f.calls.transactionSigns,0);
  }
});

test('changed completed-prefix events, claims, signatures and terminal proofs cannot reuse a warmed batch',async()=>{
  const damages=[
    f=>{f.data.events[1].blockhash=address(69);},
    f=>{f.data.events[3].messageSha256='0'.repeat(64);},
    f=>{f.data.events[4].proof.account.uri=policy.website+'/metadata/hidden/9998.json';},
    f=>{f.data.events.splice(2,1);},
    f=>{delete f.data.events[2];},
    f=>{f.data.signing[0].record.orderRevision++;},
    f=>{f.data.signing[1].record.transactionBase64=f.data.signing[5].record.transactionBase64;},
    f=>{f.data.signing[2].record.requestId='0'.repeat(64);},
    f=>{f.data.signing[3].record.signature=f.data.signing[7].record.signature;},
    f=>{f.data.orders.items[0].attempts[0].proof.account.owner=address(68);},
  ];
  const f=await fixture();await warm(f);const good=structuredClone(f.data);
  for(const damage of damages){
    Object.assign(f.data,structuredClone(good));damage(f);const changed=structuredClone(f.data);
    await assert.rejects(f.storage.readRecoverySnapshot(f.scope));await assert.rejects(f.storage.read(f.scope));assert.deepEqual(f.data,changed);
    Object.assign(f.data,structuredClone(good));await warm(f);
  }
});

test('extra undefined fields with identical JSON miss the evidence cache and fail strict canonical validation',async()=>{
  const f=await fixture();await warm(f);const good=structuredClone(f.data),json=JSON.stringify(good);
  for(const damage of [
    f=>{f.data.orders.unexpected=undefined;},
    f=>{f.data.signing[0].record.unexpected=undefined;},
    f=>{f.data.signing[0].unexpected=undefined;},
    f=>{f.data.signing[4].record.unexpected=undefined;},
    f=>{f.data.signing[6].record.unexpected=undefined;},
  ]){
    damage(f);assert.equal(JSON.stringify(f.data),json);await assert.rejects(f.storage.readRecoverySnapshot(f.scope));await assert.rejects(f.storage.read(f.scope));
    Object.assign(f.data,structuredClone(good));await warm(f);
  }
});

test('changed current-item suffix never uses cached prefix approval and failed validation cannot poison restored history',async()=>{
  const f=await fixture();f.use('verified0');await warm(f);f.use('signed1');await warm(f);const good=structuredClone(f.data);
  for(const damage of [
    f=>{f.data.events[5].index=0;},
    f=>{f.data.signing[4].record.itemIndex=0;},
    f=>{f.data.signing[5].record.transactionBase64='AAAA';},
    f=>{f.data.signing[7].record.claimId='0'.repeat(64);},
    f=>{f.data.signing.splice(6,1);},
    f=>{f.data.orders.revision--;},
  ]){
    damage(f);await assert.rejects(f.storage.readRecoverySnapshot(f.scope));Object.assign(f.data,structuredClone(good));await warm(f);
  }
  f.use('verified1');await warm(f);assert.equal((await f.storage.readBuyerSubmission(f.scope)).status,'verified');
});

test('caller mutations cannot alter cached order or batch evidence returned to later reads',async()=>{
  const f=await fixture();await warm(f);const good=structuredClone(f.data),snapshot=await f.storage.readRecoverySnapshot(f.scope),order=await f.storage.read(f.scope);
  order.items[0].attempts[0].proof.account.owner=address(68);order.items[1].attempts=[];
  snapshot.order.id='caller';snapshot.submission.input.claim.itemIndex=0;snapshot.submission.input.request.transactionBase64='AAAA';
  assert.deepEqual(f.data,good);await warm(f);assert.deepEqual((await f.storage.readRecoverySnapshot(f.scope)).order,good.orders);
});

test('historical property order used by canonical JSON bindings cannot disappear inside a sorted cache fingerprint',async()=>{
  const f=await fixture();await warm(f);const good=structuredClone(f.data),reverse=value=>Object.fromEntries(Object.entries(value).reverse());
  for(const damage of [f=>{f.data.events[1]=reverse(f.data.events[1]);},f=>{f.data.events[4].proof=reverse(f.data.events[4].proof);}]){
    damage(f);assert.notEqual(JSON.stringify(f.data),JSON.stringify(good));await assert.rejects(f.storage.readRecoverySnapshot(f.scope));
    Object.assign(f.data,structuredClone(good));await warm(f);
  }
});


test('a changed previous terminal report invalidates a cached replacement batch even when its proof and later history are unchanged',async()=>{
  const f=await fixture();f.use('signed0');const data=f.data;
  const apply=event=>{data.orders=model.transitionOrder(data.orders,event);data.events.push(event);};
  const first={order:data.orders,claim:data.signing[0].record,request:data.signing[1].record,response:{transactionBase64:data.signing[3].record.transactionBase64}};
  const proof={kind:'expired',cluster:first.order.cluster,machine:first.order.machine,collection:first.order.collection,buyer:first.order.buyer,
    asset:first.claim.asset,blockhash:first.claim.blockhash,messageSha256:first.claim.messageSha256,commitment:'finalized',slot:800,
    signature:first.order.items[0].attempts[0].signature,accountSlot:900,statusSlot:900,blockhashValid:false,blockHeight:2100,signatureAbsent:true,accountAbsent:true,addressHistoryEmpty:true};
  const report={...submissionBinding(first),cluster:'devnet',status:'expired',chainVerified:true,transactionsSent:0,networkRequests:0,restored:false,retryAuthorized:false,readyToSubmit:false,salesOpen:false,proof,
    evidence:{blockhash:first.claim.blockhash,anchorSlot:600,slot:800,blockHeight:2100,lastValidBlockHeight:2000,historyPages:1,historySha256:'e'.repeat(64)}};
  const prior=expiryRecord(first,report);apply({type:'reconcile',revision:data.orders.revision,index:0,attempt:1,proof});
  data.signing.push({phase:'expiry-reviewed',record:{version:1,orderRevision:data.orders.revision,report}});
  const replacement=replacementFor({...first,order:data.orders},prior,{blockhash:address(71),lastValidBlockHeight:4000},1000);
  const prepared=prepareAssetClaim(data.orders,replacementCandidate(data.orders,replacement)),claim=prepared.claim;
  data.orders=prepared.order;data.events.push(prepared.event);data.signing.push({phase:'claimed',record:claim,replacement});
  const message=VersionedTransaction.deserialize(Buffer.from(claim.transactionBase64,'base64')).message.serialize();
  const request=finalizeAssetRequest(data.orders,claim,new Uint8Array(await native.subtle.sign('Ed25519',data.keys[0].privateKey,message)));
  data.signing.push({phase:'ready',record:request});apply({type:'unknown',revision:data.orders.revision,index:0,attempt:2});
  const claimId='e'.repeat(64);data.signing.push({phase:'wallet-claimed',record:{version:1,claimId,requestId:buyerRequestId(request),orderRevision:data.orders.revision}});
  const tx=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));tx.sign([buyer]);
  const transactionBase64=Buffer.from(tx.serialize()).toString('base64'),checked=verifyBuyerSigningResponse(data.orders,claim,request,{transactionBase64});
  apply({type:'signature',revision:data.orders.revision,index:0,attempt:2,signature:checked.signature,messageSha256:checked.messageSha256});
  data.signing.push({phase:'buyer-response',record:{version:1,claimId,orderRevision:data.orders.revision,transactionBase64,signature:checked.signature,messageSha256:checked.messageSha256}});
  const verified={...structuredClone(f.states.verified0.orders.items[0].attempts[0].proof),blockhash:claim.blockhash,messageSha256:claim.messageSha256,signature:checked.signature};
  apply({type:'reconcile',revision:data.orders.revision,index:0,attempt:2,proof:verified});
  const next=prepareAssetClaim(data.orders,preparationFor(data.orders,{blockhash:address(72),lastValidBlockHeight:5000},1600).candidate);
  data.orders=next.order;data.events.push(next.event);data.signing.push({phase:'claimed',record:next.claim});
  await warm(f);const good=structuredClone(data);
  data.signing[4].record.report.evidence.historySha256='f'.repeat(64);
  await assert.rejects(f.storage.readRecoverySnapshot(f.scope),/REPLACEMENT_HISTORY/);
  await assert.rejects(f.storage.read(f.scope),/REPLACEMENT_HISTORY/);
  Object.assign(data,good);await warm(f);
});

test('deleting every signing row after a verified prefix cannot authorize a fresh next-item native claim',async()=>{
  const f=await fixture();f.use('verified0');await warm(f);
  const candidate=preparationFor(f.data.orders,{blockhash:address(73),lastValidBlockHeight:4000},1600).candidate;
  assert.equal(candidate.itemIndex,1);assert.equal(f.data.orders.items[1].attempts.length,0);
  f.data.signing=[];const before=structuredClone(f.data),writes=f.calls.modes.filter(mode=>mode==='readwrite').length;
  // Generic journal reads remain backward compatible, but executor evidence and
  // a fresh signing intent require the retained canonical native history.
  assert.deepEqual(await f.storage.read(f.scope),before.orders);
  await assert.rejects(f.storage.readRecoverySnapshot(f.scope),/ASSET_CLAIM_HISTORY/);
  await assert.rejects(f.storage.readCostSummary(f.scope),/ASSET_CLAIM_HISTORY/);
  await assert.rejects(f.storage.prepareAssetSigning(f.scope,candidate),/ASSET_CLAIM_HISTORY/);
  assert.deepEqual(f.data,before);assert.equal(f.calls.modes.filter(mode=>mode==='readwrite').length,writes);
  assert.equal(f.calls.transactionSigns,0);assert.equal(f.calls.keyGeneration,0);
});


test('cost summary totals retained failed fees without inventing successful fees or an actual full-order total',async()=>{
  const f=await fixture();await warm(f);const data=f.data;
  const input={order:data.orders,claim:data.signing[4].record,request:data.signing[5].record,response:{transactionBase64:data.signing[7].record.transactionBase64}};
  const {account,...base}=structuredClone(f.states.verified1.orders.items[1].attempts[0].proof);
  const proof={...base,kind:'failed',executionFailed:true,accountAbsent:true};
  const report={...submissionBinding(input),cluster:'devnet',status:'failed',chainVerified:true,transactionsSent:0,networkRequests:0,restored:false,retryAuthorized:false,readyToSubmit:false,salesOpen:false,proof,
    evidence:{slot:proof.slot,statusSlot:proof.accountSlot,errorSha256:'f'.repeat(64),feeLamports:'10000',payerDebitLamports:'10000',payerPreBalanceLamports:'20000000000',payerPostBalanceLamports:'19999990000'}};
  const event={type:'reconcile',revision:data.orders.revision,index:1,attempt:1,proof};
  data.orders=model.transitionOrder(data.orders,event);data.events.push(event);
  data.signing.push({phase:'failure-reviewed',record:{version:1,orderRevision:data.orders.revision,report}});
  const before=structuredClone(data),summary=await f.storage.readCostSummary(f.scope);
  assert.equal(summary.quantity,2);assert.equal(summary.verified,1);assert.equal(summary.remaining,1);assert.equal(summary.currentItemIndex,1);
  assert.equal(summary.verifiedItemPriceLamports,'200000000');assert.equal(summary.knownFailedFeesLamports,'10000');
  assert.deepEqual(summary.failedAttempts,[{itemIndex:1,attempt:1,feeLamports:'10000'}]);
  assert.equal(summary.approvedCurrentTemplate,null);assert.equal(summary.successfulTransactionFeesLamports,null);assert.equal(summary.actualOrderTotalLamports,null);
  assert.equal(summary.nextItemRequiresFreshQuote,true);assert.equal(summary.readyToSubmit,false);assert.equal(summary.salesOpen,false);
  summary.failedAttempts[0].feeLamports='0';summary.knownFailedFeesLamports='0';
  const repeated=await f.storage.readCostSummary(f.scope);assert.equal(repeated.knownFailedFeesLamports,'10000');assert.equal(repeated.failedAttempts[0].feeLamports,'10000');
  assert.deepEqual(data,before);assert.ok(f.calls.modes.every(mode=>mode==='readonly'));assert.equal(f.calls.transactionSigns,0);assert.equal(f.calls.keyGeneration,0);
});
