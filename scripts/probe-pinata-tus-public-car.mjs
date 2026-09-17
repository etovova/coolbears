// Harmless protocol probe: publish a tiny CAR containing only the bytes "hello".
// This validates Pinata TUS + car=true behavior without using any CoolBears NFT data.
// Success is proven by retrieving the deterministic root CID from public IPFS and
// matching the exact payload bytes. Public-file listing is only supplemental.
import crypto from 'node:crypto';
import {client,requireThat} from './pinata-backup-io.mjs';
const NAME='CoolBears harmless public TUS CAR protocol probe v1';
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const enc=v=>Buffer.from(v,'utf8').toString('base64');
const varint=n=>{const a=[];let x=n;while(x>=128){a.push((x&127)|128);x=Math.floor(x/128)}a.push(x);return Buffer.from(a)};
const b32=b=>{const alpha='abcdefghijklmnopqrstuvwxyz234567';let out='',bits=0,val=0;for(const x of b){val=(val<<8)|x;bits+=8;while(bits>=5){out+=alpha[(val>>>(bits-5))&31];bits-=5}}if(bits)out+=alpha[(val<<(5-bits))&31];return out};
const data=Buffer.from('hello','utf8'),digest=crypto.createHash('sha256').update(data).digest();
const cidBytes=Buffer.concat([Buffer.from([0x01,0x55,0x12,0x20]),digest]);
const expectedCid='b'+b32(cidBytes);
const header=Buffer.concat([Buffer.from([0xa2,0x65]),Buffer.from('roots'),Buffer.from([0x81,0xd8,0x2a,0x58,0x25,0x00]),cidBytes,Buffer.from([0x67]),Buffer.from('version'),Buffer.from([0x01])]);
const car=Buffer.concat([varint(header.length),header,varint(cidBytes.length+data.length),cidBytes,data]);
const api=client(jwt);
const result={schema:2,status:'TUS_PUBLIC_CAR_PROBE_NOT_COMPLETED',carBytes:car.length,createStatus:null,patchStatus:null,gatewayVerified:false,listedSupplementally:false,reusedExisting:false,nftDataUsed:false,idsExposed:false,cidsExposed:false,urlsExposed:false};
async function gatewayHasExpected(){
 try{
  const r=await fetch('https://gateway.pinata.cloud/ipfs/'+expectedCid,{redirect:'follow',signal:AbortSignal.timeout(30000)});
  if(!r.ok)return false;const b=Buffer.from(await r.arrayBuffer());return b.equals(data);
 }catch{return false;}
}
async function supplementalListing(){
 try{
  const q=await api.api('/v3/files/public?name='+encodeURIComponent(NAME)+'&limit=10');
  const rows=q?.data?.files;return Array.isArray(rows)&&rows.some(x=>x?.name===NAME&&x?.cid===expectedCid);
 }catch{return false;}
}
try{
  // If a previous probe already finished asynchronously, prove it from public IPFS and stop.
  if(await gatewayHasExpected()){
    result.gatewayVerified=true;result.reusedExisting=true;result.listedSupplementally=await supplementalListing();result.status='TUS_PUBLIC_CAR_PROTOCOL_VERIFIED';
  } else {
    const meta=`filename ${enc('harmless-hello.car')},network ${enc('public')},name ${enc(NAME)},car ${enc('true')}`;
    const create=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Length':String(car.length),'Upload-Metadata':meta},redirect:'manual',signal:AbortSignal.timeout(30000)});
    result.createStatus=create.status;requireThat(create.status===201,'TUS_CREATE_HTTP_'+create.status);
    const loc=create.headers.get('location');requireThat(loc,'TUS_LOCATION_MISSING');const u=new URL(loc,'https://uploads.pinata.cloud/v3/files');
    requireThat(u.protocol==='https:'&&u.hostname==='uploads.pinata.cloud'&&!u.username&&!u.password,'TUS_LOCATION_UNTRUSTED');
    const patch=await fetch(u.href,{method:'PATCH',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Offset':'0','Content-Type':'application/offset+octet-stream','Content-Length':String(car.length)},body:car,redirect:'manual',signal:AbortSignal.timeout(30000)});
    result.patchStatus=patch.status;requireThat(patch.status===204,'TUS_PATCH_HTTP_'+patch.status);requireThat(Number(patch.headers.get('upload-offset'))===car.length,'TUS_FINAL_OFFSET_MISMATCH');
    for(let i=0;i<180;i++){if(await gatewayHasExpected()){result.gatewayVerified=true;break}await new Promise(r=>setTimeout(r,2000));}
    requireThat(result.gatewayVerified,'TUS_PUBLIC_CAR_GATEWAY_NOT_READY');
    result.listedSupplementally=await supplementalListing();result.status='TUS_PUBLIC_CAR_PROTOCOL_VERIFIED';
  }
}catch(e){result.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'TUS_PUBLIC_CAR_PROBE_ERROR';process.exitCode=1;}
console.log(JSON.stringify(result));
