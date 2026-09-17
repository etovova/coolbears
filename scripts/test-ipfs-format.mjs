// Synthetic hello/pattern files only. No collection images, CIDs, metadata or secrets.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {CarReader} from '@ipld/car';import * as pb from '@ipld/dag-pb';import {UnixFS} from 'ipfs-unixfs';
const fixture=JSON.parse(fs.readFileSync('scripts/ipfs-fixture.json','utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest();
function vu(n){const out=[];while(n>127){out.push((n&127)|128);n>>>=7;}out.push(n);return Buffer.from(out);}
const header=Buffer.from(fixture.headerHex,'hex'),chunks=[vu(header.length),header];
for(const x of fixture.blocks){const c=Buffer.from(x.cid,'hex'),b=x.dataHex?Buffer.from(x.dataHex,'hex'):Buffer.from(Array.from({length:x.sequence256Bytes},(_,i)=>i%256));chunks.push(vu(c.length+b.length),c,b);}
const bytes=Buffer.concat(chunks);assert.equal(hash(bytes).toString('hex'),fixture.carSha256,'Fixture differs from Python CAR');
const car=await CarReader.fromBytes(bytes),roots=await car.getRoots();assert.equal(roots.length,1);
let blocks=0;for await(const block of car.blocks()){
 assert.ok(hash(block.bytes).equals(Buffer.from(block.cid.multihash.digest)));
 if(block.cid.code===pb.code){const decoded=pb.decode(block.bytes);assert.ok(Buffer.from(pb.encode(decoded)).equals(Buffer.from(block.bytes)),'Noncanonical DAG-PB');UnixFS.unmarshal(decoded.Data);}
 blocks++;
}
async function read(cid){const block=await car.get(cid);assert.ok(block);if(cid.code===0x55)return {bytes:Buffer.from(block.bytes),dagSize:block.bytes.length};const n=pb.decode(block.bytes),u=UnixFS.unmarshal(n.Data);assert.equal(u.type,'file');let all=[],size=block.bytes.length;for(let i=0;i<n.Links.length;i++){const part=await read(n.Links[i].Hash);assert.equal(part.dagSize,n.Links[i].Tsize);assert.equal(BigInt(part.bytes.length),u.blockSizes[i]);all.push(part.bytes);size+=part.dagSize;}const b=Buffer.concat(all);assert.equal(BigInt(b.length),u.fileSize());return{bytes:b,dagSize:size};}
const root=pb.decode((await car.get(roots[0])).bytes);assert.equal(UnixFS.unmarshal(root.Data).type,'directory');assert.deepEqual(root.Links.map(x=>x.Name),['chunked.bin','hello.txt']);
for(const link of root.Links){const f=await read(link.Hash);assert.equal(f.dagSize,link.Tsize);if(link.Name==='hello.txt')assert.equal(f.bytes.toString(),'hello\n');else {assert.equal(f.bytes.length,768000);for(let i=0;i<f.bytes.length;i++)assert.equal(f.bytes[i],i%256);}}
fs.mkdirSync('build/ipfs-format',{recursive:true});const report={status:'PASS',format:'CARv1 / CIDv1 / DAG-PB / UnixFS',fixture:'synthetic only',blocksChecked:blocks,filesReconstructed:2,canonicalDagPb:true,realCollectionPublished:false,networkRequests:0};fs.writeFileSync('build/ipfs-format/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
