// Browser-only fixtures. Never bundled by the public site or operator UI.
import { createBuyerStorage } from '../../orders/browser-storage.mjs';
import { createOrderModel } from '../../orders/journal-model.mjs';
import { createOrderPlanner } from '../../orders/transaction-model.mjs';
import { verifyBuyerSigningResponse } from '../../orders/signing.mjs';
import policy from '../../../metadata/policy.json' with { type:'json' };
import { base58 } from '@metaplex-foundation/umi/serializers';
const model=createOrderModel(policy), planner=createOrderPlanner(model), native=globalThis.crypto;
const database='coolbears-buyer-custody-v1';
const scopeKey=s=>JSON.stringify(Object.fromEntries(['id','cluster','buyer','machine','collection','guard'].map(k=>[k,s[k]])));
async function raw(names,mode,action){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(database);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(names,mode);let result;tx.oncomplete=()=>resolve(result?.result);tx.onabort=tx.onerror=()=>reject(tx.error);result=action(tx);});}
  finally{db.close();}
}
window.assetSignAttempts=0;window.assetSignatures=0;window.persistedBeforeSign=[];
const subtle=new Proxy(native.subtle,{get(target,property){
  if(property!=='sign')return typeof target[property]==='function'?target[property].bind(target):target[property];
  return async(...args)=>{
    const transaction=new Uint8Array(args[2])[0]===128;
    if(!transaction&&window.failNextCustodySign){window.failNextCustodySign=false;throw Error('fixture lost post-commit readback');}
    if(transaction){
      window.assetSignAttempts++;
      const key=scopeKey(window.auditScope);
      const order=await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(key));
      const rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
      const observed={revision:order?.revision,state:order?.items[0].attempts.at(-1)?.state,phases:rows.map(r=>r.phase)};
      window.persistedBeforeSign.push(observed);
      const claimed=rows.at(-1),number=order?.items[0].attempts.length;
      if(observed.revision!==claimed?.record?.orderRevision||observed.state!=='wallet-pending'||claimed.phase!=='claimed'
        ||claimed.record.attempt!==number||(number===1?rows.length!==1:!claimed.replacement||!['expired','failed'].includes(order.items[0].attempts[0].state)))throw Error('SIGN_BEFORE_COMMIT');
      if(number===2&&order.items[0].attempts[0].state==='failed'){
        const replacement=claimed.replacement,reviewed=rows.find(r=>r.phase==='failure-reviewed')?.record.report;
        if(replacement.version!==2||!reviewed||typeof replacement.acknowledgedFeeLamports!=='string'
          ||replacement.acknowledgedFeeLamports!==reviewed.evidence.feeLamports
          ||JSON.stringify(replacement.prior.evidence)!==JSON.stringify(reviewed.evidence)
          ||JSON.stringify(replacement.prior.proof)!==JSON.stringify(reviewed.proof)
          ||JSON.stringify(reviewed.proof)!==JSON.stringify(order.items[0].attempts[0].proof))throw Error('SIGN_BEFORE_FEE_REVIEW');
      }
      if(window.signMode==='fail')throw Error('fixture native signer failure');
      if(window.signMode==='hold'){window.signEntered=true;await new Promise(resolve=>window.releaseSigning=resolve);}
    }
    const signature=await target.sign(...args);if(transaction){window.assetSignatures++;window.lastNativeSignature=[...new Uint8Array(signature)];}return signature;
  };
}});
const makeStore=()=>createBuyerStorage({crypto:{subtle,getRandomValues:native.getRandomValues.bind(native)}});
const originalAdd=IDBObjectStore.prototype.add;
IDBObjectStore.prototype.add=function(value,key){
  if(this.name==='signing'&&value.phase==='prewallet-recovered'&&window.losePrewalletReadback){
    window.losePrewalletReadback=false;this.transaction.addEventListener('complete',()=>{window.failNextCustodySign=true;});
  }
  if(this.name==='signing'&&value.phase==='ready'){
    window.readyWriteAttempts=(window.readyWriteAttempts??0)+1;
    if(window.loseNativeReadback){window.loseNativeReadback=false;this.transaction.addEventListener('complete',()=>{window.failNextCustodySign=true;});}
  }
  if(this.name==='signing'&&value.phase===window.writeFailure)throw new DOMException('fixture quota','QuotaExceededError');
  return originalAdd.call(this,value,key);
};
async function seedLegacy(input){
  const pair=await native.subtle.generateKey('Ed25519',false,['sign','verify']);
  const asset=base58.deserialize(new Uint8Array(await native.subtle.exportKey('raw',pair.publicKey)))[0];
  const order=model.createOrder({...input,assets:[asset]});const key=scopeKey(input);
  const db=await new Promise((resolve,reject)=>{
    const r=indexedDB.open(database,1);r.onupgradeneeded=()=>{for(const name of ['orders','keys','events'])r.result.createObjectStore(name);};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  await new Promise((resolve,reject)=>{const tx=db.transaction(['orders','keys','events'],'readwrite',{durability:'strict'});tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);
    tx.objectStore('orders').add(order,key);tx.objectStore('events').add({type:'create',order},[key,0]);
    tx.objectStore('keys').add({version:1,scopeKey:key,index:0,asset,...pair},[key,0]);
  });
  // Hold a legacy connection deliberately to exercise blocked upgrade handling.
  db.onversionchange=()=>{window.legacyVersionChange=true;};window.legacyConnection=db;
  return order;
}
Object.assign(window,{makeStore,store:makeStore(),raw,scopeKey,model,verifyBuyerSigningResponse,seedLegacy,
  code:async promise=>{try{await promise;return 'UNEXPECTED_SUCCESS';}catch(e){return e.message;}},
  candidate:(order,block)=>({orderRevision:order.revision,itemIndex:0,...block,transactionBase64:Buffer.from(planner.buildOrderTransactions(order,block).templates[0].unsignedBytes).toString('base64')}),
});
