// Disposable wallet and browser permission fixture around the actual production
// app/factory. No application port, storage or gateway adapter is substituted.
import {getWallets} from '@wallet-standard/app';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import secret from 'private-console:fixture-wallet';
import config from 'private-console:config';
import {networkProfile} from '../../deployment/network.mjs';
const network=networkProfile(config.cluster);
const counterKey='fixture:private-console-integration:counters';
const counters=JSON.parse(localStorage.getItem(counterKey)||'null')??{native:0,wallet:0,send:0,connect:0,persist:0};
const count=key=>{counters[key]++;localStorage.setItem(counterKey,JSON.stringify(counters));};
async function journal(){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('coolbears-buyer-custody-v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['orders','events','signing','keys'],'readonly'),names=['orders','events','signing','keys'];
    const requests=names.map(name=>tx.objectStore(name).getAll());
    tx.onabort=tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>resolve(Object.fromEntries(names.map((name,index)=>[name,
      name==='keys'?requests[index].result.map(row=>({index:row.index,asset:row.asset,privateType:row.privateKey.type,extractable:row.privateKey.extractable})):requests[index].result])));
  });}finally{db.close();}
}
// This substitutes the browser permission response only. Real Web Locks and
// native non-extractable IndexedDB keys remain in use.
Object.defineProperty(navigator.storage,'persist',{value:async()=>{count('persist');localStorage.setItem(counterKey+':permission','granted');return true;}});
Object.defineProperty(navigator.storage,'persisted',{value:async()=>localStorage.getItem(counterKey+':permission')==='granted'});
const nativeSign=SubtleCrypto.prototype.sign;
SubtleCrypto.prototype.sign=async function(...args){
  const bytes=new Uint8Array(args[2]);
  if(bytes[0]===128){
    const saved=await journal();
    if(saved.signing.at(-1)?.phase!=='claimed'||saved.orders[0]?.items[0]?.attempts.at(-1)?.state!=='wallet-pending')throw Error('NATIVE_BEFORE_DURABLE_CLAIM');
    count('native');
  }
  return nativeSign.apply(this,args);
};
const buyer=Keypair.fromSecretKey(new Uint8Array(secret)),account={address:buyer.publicKey.toBase58(),publicKey:buyer.publicKey.toBytes(),
  chains:[network.walletChain],features:['solana:signTransaction']};
const wallet={version:'1.0.0',name:'Disposable console integration wallet',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
  accounts:[account],chains:[network.walletChain],features:{
    'standard:connect':{version:'1.0.0',connect:async()=>{count('connect');return{accounts:[account]};}},
    'standard:events':{version:'1.0.0',on:()=>()=>{}},
    'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:[0],signTransaction:async input=>{
      if(input.account!==account||input.chain!==network.walletChain)throw Error('WRONG_SYNTHETIC_ACCOUNT');
      const saved=await journal(),claim=saved.signing.at(-1);
      if(claim?.phase!=='wallet-claimed'||!claim.record.costApproval||saved.orders[0]?.items[0]?.attempts.at(-1)?.state!=='unknown')throw Error('WALLET_BEFORE_DURABLE_CONSENT');
      count('wallet');const tx=VersionedTransaction.deserialize(input.transaction);tx.sign([buyer]);
      window.integration.signedBytes=Buffer.from(tx.serialize()).toString('base64');return[{signedTransaction:tx.serialize()}];
    }},
    'solana:signAndSendTransaction':{version:'1.0.0',signAndSendTransaction:()=>{count('send');throw Error('SEND_FORBIDDEN');}},
  }};
getWallets().register(wallet);
window.integration={counters,journal,address:account.address,loaded:false};
await import('../../orders/buyer-console/app.mjs');
window.integration.loaded=true;
