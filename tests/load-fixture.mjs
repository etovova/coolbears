import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {bitArray,base58} from '@metaplex-foundation/umi/serializers';
import {CANDY_MACHINE_HIDDEN_SECTION} from '@metaplex-foundation/mpl-core-candy-machine';
export const fixture=JSON.parse(await readFile(new URL('./fixtures/upload-machine-1950.json',import.meta.url),'utf8'));
const raw=gunzipSync(Buffer.from(fixture.result.value.data[0],'base64'));
export const SLOT=fixture.result.context.slot;
export const signature=base58.deserialize(new Uint8Array(64).fill(9))[0];
export function account(count=1950,slot=SLOT){
 const data=Buffer.from(raw),section=CANDY_MACHINE_HIDDEN_SECTION;
 data.writeUInt32LE(count,section);
 for(let i=1950;i<count;i++){
  const id=String(i).padStart(4,'0'),offset=section+4+i*29;
  data.fill(0,offset,offset+29);data.write(`${id} — Hidden Bear`,offset);data.write(`${id}.json`,offset+20);
 }
 Buffer.from(bitArray(1251).serialize(Array.from({length:10008},(_,i)=>i<count))).copy(data,section+4+10000*29);
 return {...fixture.result,context:{...fixture.result.context,slot},value:{...fixture.result.value,data:[data.toString('base64'),'base64']}};
}
export function memoryStore(entries=[]){
 const data=new Map(entries);let held=false;
 return {data,read:k=>structuredClone(data.get(k)??null),write:(k,v)=>data.set(k,structuredClone(v)),lock:async fn=>{if(held)throw Error('already locked');held=true;try{return await fn();}finally{held=false;}}};
}
