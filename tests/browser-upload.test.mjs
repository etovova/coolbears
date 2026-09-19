import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserUploadStore} from '../solana/browser-upload-store.mjs';
test('Browser journal persists across instances and storage failures stop writes',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const a=browserUploadStore(storage),b=browserUploadStore(storage);a.write('x',{pending:'signature'});assert.deepEqual(b.read('x'),{pending:'signature'});
 storage.setItem=()=>{throw Error('quota');};assert.throws(()=>a.write('x',{}),/quota/);assert.deepEqual(b.read('x'),{pending:'signature'});
});
test('Browser lock rejects unsupported environment and a concurrent tab',async()=>{
 const a=browserUploadStore({},null);assert.throws(()=>a.withLock('x',()=>{}),/не поддерживает/);
 let held=false;const locks={request:async(k,o,fn)=>{assert.equal(o.ifAvailable,true);if(held)return fn(null);held=true;try{return await fn({name:k});}finally{held=false;}}};
 const b=browserUploadStore({},locks);await b.withLock('x',async()=>{await assert.rejects(b.withLock('x',()=>{}),/другой вкладке/);});
 await b.withLock('x',async()=>{});
});
