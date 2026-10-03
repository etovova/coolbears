// New storage checks around the existing disposable Wallet Standard fixture.
// Production console, browser IndexedDB/Web Locks and all adapters stay intact.
import {createBuyerStorage} from '../../orders/browser-storage.mjs';
import config from 'private-console:config';
await import('./buyer-console-integration.mjs');
const fields=['id','cluster','buyer','machine','collection','guard'];
const hiddenOptions={storageMode:config.storageMode,hiddenCommitmentSha256:config.hiddenCommitmentSha256};
window.integration.scope=order=>Object.fromEntries([...fields,'storageMode','hiddenCommitmentSha256'].map(key=>[key,order[key]]));
window.integration.storage=createBuyerStorage({storageOptions:hiddenOptions});
window.integration.legacy=createBuyerStorage();
window.integration.legacyScope=scope=>Object.fromEntries(fields.map(key=>[key,scope[key]]));
window.integration.wrongProfile=async scope=>{
  const wrong=createBuyerStorage({storageOptions:{...hiddenOptions,hiddenCommitmentSha256:'b'.repeat(64)}});
  try { await wrong.read(scope); return 'UNEXPECTED_SUCCESS'; }
  catch(error){return error.message;}
  finally{wrong.close();}
};
window.integration.rawKeys=async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('coolbears-buyer-custody-v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['orders'],'readonly'),r=tx.objectStore('orders').getAllKeys();
    tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}
};
window.integration.loaded=true;
