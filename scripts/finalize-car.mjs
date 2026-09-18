import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, open, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDirectoryEncoderStream } from 'ipfs-car';
import { CarIndexedReader } from '@ipld/car/indexed-reader';
import { CarIndexer } from '@ipld/car/indexer';
import { CarWriter } from '@ipld/car/writer';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as dagPB from '@ipld/dag-pb';
import * as raw from 'multiformats/codecs/raw';
import { UnixFS } from 'ipfs-unixfs';
import { exporter } from 'ipfs-unixfs-exporter';
import varint from 'varint';

const dir='private/fresh-20260918', car=`${dir}/collection.car`;
async function main(){
const imageRoot=CID.parse((await readFile(`${dir}/images-root.PRIVATE.txt`,'utf8')).trim());
// Retain every existing image block unchanged. Drop only the previous metadata
// tail so repeated builds never accumulate obsolete descriptions.
const indexer=await CarIndexer.fromIterable(createReadStream(car));
let imageEnd=0;
for await (const entry of indexer) {
  if (entry.cid.equals(imageRoot)) { imageEnd=Number(entry.blockOffset)+entry.blockLength; break; }
}
assert(imageEnd>0,'Original image root must exist before metadata replacement');
const imageFile=await open(car,'r+');
await imageFile.truncate(imageEnd);
await CarWriter.updateRootsInFile(imageFile,[imageRoot]);
await imageFile.close();
const plan=JSON.parse(await readFile(`${dir}/plan.PRIVATE.json`,'utf8'));
const expected=JSON.parse(await readFile(`${dir}/image-checksums.PRIVATE.json`,'utf8'));
const counts={};for(const row of plan)for(const [key,value] of Object.entries(row.traits)){counts[key]??={};counts[key][value]=(counts[key][value]||0)+1;}
const initialReader=await CarIndexedReader.fromFile(car);
const imageRootBlock=await initialReader.get(imageRoot);assert(imageRootBlock);
const imageSize=imageRootBlock.bytes.length+dagPB.decode(imageRootBlock.bytes).Links.reduce((s,l)=>s+(l.Tsize||0),0);
await initialReader.close();
await mkdir(`${dir}/metadata`,{recursive:true});
const files=[];
for(const row of plan){
  const id=String(row.index).padStart(4,'0');
  const image=`ipfs://${imageRoot}/${id}.png`;
  const metadata={name:`CoolBears #${id}`,description:'Everyone gets a bear. Not everyone gets a legend.',image,external_url:'https://coolbears-nfts.com',attributes:Object.entries(row.traits).map(([trait_type,value])=>({trait_type,value})),properties:{files:[{uri:image,type:'image/png'}],category:'image',rarity:{rank:row.rank,score:row.score,trait_frequencies:Object.fromEntries(Object.entries(row.traits).map(([k,v])=>[k,{count:counts[k][v],percentage:counts[k][v]/100}]))}}};
  const bytes=Buffer.from(JSON.stringify(metadata)+'\n');
  await writeFile(`${dir}/metadata/${id}.json`,bytes);
  files.push({name:`${id}.json`,stream:()=>new Blob([bytes]).stream()});
}
const fd=await open(car,'r+');
let position=(await fd.stat()).size;
async function append(block){
  const header=Buffer.from(varint.encode(block.cid.bytes.length+block.bytes.length));
  for(const bytes of [header,block.cid.bytes,block.bytes]){let offset=0;while(offset<bytes.length){const {bytesWritten}=await fd.write(bytes,offset,bytes.length-offset,position);assert(bytesWritten>0);position+=bytesWritten;offset+=bytesWritten;}}
}
let metadataRootBlock;
for await(const block of createDirectoryEncoderStream(files)){await append(block);metadataRootBlock=block;}
assert(metadataRootBlock);
const metadataSize=metadataRootBlock.bytes.length+dagPB.decode(metadataRootBlock.bytes).Links.reduce((s,l)=>s+(l.Tsize||0),0);
const collectionBytes=await readFile('metadata/collection.json');
const collectionBlock={bytes:collectionBytes,cid:CID.createV1(raw.code,await sha256.digest(collectionBytes))};await append(collectionBlock);
const rootBytes=dagPB.encode(dagPB.prepare({Data:new UnixFS({type:'directory'}).marshal(),Links:[{Name:'images',Hash:imageRoot,Tsize:imageSize},{Name:'metadata',Hash:metadataRootBlock.cid,Tsize:metadataSize},{Name:'collection.json',Hash:collectionBlock.cid,Tsize:collectionBytes.length}]}));
const root=CID.createV1(dagPB.code,await sha256.digest(rootBytes));await append({cid:root,bytes:rootBytes});
await CarWriter.updateRootsInFile(fd,[root]);await fd.close();
await writeFile(`${dir}/manifest.PRIVATE.json`,JSON.stringify({version:'solana-20260918',root:root.toString(),imagesRoot:imageRoot.toString(),metadataRoot:metadataRootBlock.cid.toString(),finalPrefix:`ipfs://${root}/metadata/`,bytes:position},null,2));
const revealData=plan.map(row=>({index:row.index,name:`CoolBears #${String(row.index).padStart(4,'0')}`,uri:`ipfs://${root}/metadata/${String(row.index).padStart(4,'0')}.json`}));
await writeFile(`${dir}/reveal-map.PRIVATE.json`,JSON.stringify(revealData));
await writeFile(`${dir}/reveal-commitment.json`,JSON.stringify({version:'solana-20260918',algorithm:'SHA-256',hash:createHash('sha256').update(JSON.stringify(revealData)).digest('hex'),earliestRevealDate:'2027-01-01',items:10000},null,2));
console.log(JSON.stringify({packaged:true,items:plan.length,bytes:position}));
const reader=await CarIndexedReader.fromFile(car);
const store={get:async function* (cid){const block=await reader.get(cid);assert(block);const h=await sha256.digest(block.bytes);assert.equal(Buffer.from(h.digest).toString('hex'),Buffer.from(cid.multihash.digest).toString('hex'));yield block.bytes;}};
for(const row of expected){
  const id=String(row.index).padStart(4,'0');
  const entry=await exporter(`${root}/images/${id}.png`,store);
  const hash=createHash('sha256');let size=0;for await(const b of entry.content()){hash.update(b);size+=b.length;}
  assert.equal(hash.digest('hex'),row.sha256);assert.equal(size,row.bytes);
  const meta=await exporter(`${root}/metadata/${id}.json`,store);let text='';for await(const b of meta.content())text+=Buffer.from(b).toString('utf8');
  assert.equal(text,await readFile(`${dir}/metadata/${id}.json`,'utf8'));
  if((row.index+1)%1000===0)console.log(JSON.stringify({verifiedCarImages:row.index+1,verifiedMetadata:row.index+1}));
}
await reader.close();
const hash=createHash('sha256');for await(const b of createReadStream(car))hash.update(b);
const report={version:'solana-20260918',images:10000,metadata:10000,allReachableFromRoot:true,byteChecksPassed:true,carBytes:(await stat(car)).size,carSha256:hash.digest('hex')};
await writeFile(`${dir}/car-verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
