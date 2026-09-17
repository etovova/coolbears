// Store the already hash-verified final CAR as fixed private Pinata chunks.
// Each chunk is independently downloaded and SHA-256 verified. The downloaded
// chunks are then hashed in order to prove byte-for-byte reconstruction of the
// original CAR. Private file IDs, CIDs, signed URLs and secrets are never logged.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {client,requireThat} from './pinata-backup-io.mjs';

const EXPECTED='3d6377484e3d27361c367be7b002a065d83426342df30f25e1d681b4d50f820c';
const EXPECTED_BYTES=12781754123;
const PART_BYTES=256*1024*1024;
const PARTS=Math.ceil(EXPECTED_BYTES/PART_BYTES);
const PREFIX='CoolBears v3 FINAL CAR 3d637748 part';
const partName=i=>`${PREFIX} ${String(i+1).padStart(3,'0')} of ${String(PARTS).padStart(3,'0')}`;
const expectedPartBytes=i=>Math.min(PART_BYTES,EXPECTED_BYTES-i*PART_BYTES);

const hashFile=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const feedHash=(h,p)=>new Promise((resolve,reject)=>{const s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',resolve);});
const runCurl=(args,{capture=true}={})=>new Promise((resolve,reject)=>{const p=spawn('curl',args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='';if(capture)p.stdout.on('data',b=>{out+=b});p.stderr.on('data',()=>{});p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error('CURL_PROCESS_'+c)));});

async function createPart(car,target,i){
  const start=i*PART_BYTES,end=start+expectedPartBytes(i)-1;
  await pipeline(fs.createReadStream(car,{start,end}),fs.createWriteStream(target,{flags:'wx',mode:0o600}));
  requireThat(fs.statSync(target).size===expectedPartBytes(i),'LOCAL_PART_SIZE_MISMATCH');
  return hashFile(target);
}
async function uploadPart(jwt,partFile,name){
  const out=await runCurl(['--silent','--show-error','--request','POST','https://uploads.pinata.cloud/v3/files','--header','Authorization: Bearer '+jwt,'--form','network=private','--form','name='+name,'--form','file=@'+partFile+';type=application/octet-stream','--write-out','\n%{http_code}']);
  const cut=out.lastIndexOf('\n');requireThat(cut>=0,'UPLOAD_STATUS_MISSING');
  const code=Number(out.slice(cut+1).trim());
  requireThat(Number.isInteger(code)&&code>=200&&code<300,'PRIVATE_PART_UPLOAD_HTTP_'+code);
  let parsed;try{parsed=JSON.parse(out.slice(0,cut))}catch{throw Error('UPLOAD_RESPONSE_NOT_JSON')}
  const f=parsed?.data;requireThat(f&&typeof f.id==='string'&&typeof f.cid==='string','UPLOAD_RECEIPT_MISSING');
  return f;
}
async function signedDownload(api,gateway,row,target){
  requireThat(typeof row.id==='string'&&typeof row.cid==='string','PRIVATE_PART_IDENTIFIER_MISSING');
  const meta=await api.api('/v3/files/private/'+encodeURIComponent(row.id));
  requireThat(meta.data?.id===row.id&&meta.data?.cid===row.cid,'PRIVATE_PART_METADATA_MISMATCH');
  const url=new URL(gateway).origin+'/files/'+row.cid;
  const signed=await api.api('/v3/files/sign',{method:'POST',body:{url,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
  const link=typeof signed.data==='string'?signed.data:signed.data?.url;requireThat(typeof link==='string','NO_SIGNED_PART_DOWNLOAD');
  const u=new URL(link),wanted=new URL(url);requireThat(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_PART_TARGET_MISMATCH');
  await runCurl(['--fail','--silent','--show-error','--location','--retry','5','--retry-delay','3','--output',target,u.href],{capture:false});
}

const carPath=fs.readFileSync('build/private-final-car/car-path.txt','utf8').trim();
requireThat(fs.existsSync(carPath),'CAR_NOT_FOUND');
requireThat(fs.statSync(carPath).size===EXPECTED_BYTES,'PREUPLOAD_CAR_SIZE_MISMATCH');
requireThat((await hashFile(carPath))===EXPECTED,'PREUPLOAD_CAR_HASH_MISMATCH');
requireThat(PARTS===48&&expectedPartBytes(PARTS-1)===165287691,'PARTITION_POLICY_MISMATCH');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const api=client(jwt),gateway=await api.gateway(process.env.PINATA_GATEWAY);
const listing=await api.api('/v3/files/private?limit=100');
requireThat(Array.isArray(listing?.data?.files),'PRIVATE_LIST_SHAPE_MISMATCH');
// With the four recovery parts plus 48 final-CAR chunks, the intended set is <100.
// Refuse an unexpected pagination state rather than risk missing a duplicate chunk.
requireThat(!listing.data.next_page_token,'PRIVATE_LIST_UNEXPECTED_PAGINATION');
const rows=listing.data.files;

const tmp=path.join(process.env.RUNNER_TEMP,'coolbears-final-car-parts');
fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(tmp,{recursive:true,mode:0o700});
let uploaded=0,reused=0,verified=0,totalReadback=0;
const reassembly=crypto.createHash('sha256');
try{
  for(let i=0;i<PARTS;i++){
    const name=partName(i),partFile=path.join(tmp,`part-${String(i+1).padStart(3,'0')}.bin`),readback=partFile+'.readback';
    const localHash=await createPart(carPath,partFile,i);
    const existing=rows.filter(x=>x?.name===name);
    requireThat(existing.length<=1,'DUPLICATE_PRIVATE_FINAL_CAR_PART');
    let row;
    if(existing.length===1){
      row=existing[0];
      requireThat(Number(row.size)===expectedPartBytes(i),'EXISTING_PRIVATE_PART_SIZE_MISMATCH');
      reused++;
    }else{
      row=await uploadPart(jwt,partFile,name);
      requireThat((row.network??'private')==='private','PRIVATE_PART_NETWORK_NOT_CONFIRMED');
      if(row.size!==undefined)requireThat(Number(row.size)===expectedPartBytes(i),'UPLOADED_PRIVATE_PART_SIZE_MISMATCH');
      uploaded++;
    }
    await signedDownload(api,gateway,row,readback);
    requireThat(fs.statSync(readback).size===expectedPartBytes(i),'PRIVATE_PART_READBACK_SIZE_MISMATCH');
    requireThat((await hashFile(readback))===localHash,'PRIVATE_PART_READBACK_HASH_MISMATCH');
    await feedHash(reassembly,readback);totalReadback+=fs.statSync(readback).size;verified++;
    fs.rmSync(partFile,{force:true});fs.rmSync(readback,{force:true});
    console.log(`PRIVATE_FINAL_CAR_PART_VERIFIED ${i+1}/${PARTS}`);
  }
  const reassembledHash=reassembly.digest('hex');
  requireThat(totalReadback===EXPECTED_BYTES,'FULL_PRIVATE_READBACK_SIZE_MISMATCH');
  requireThat(reassembledHash===EXPECTED,'FULL_PRIVATE_READBACK_HASH_MISMATCH');
  const summary={schema:2,status:'PRIVATE_FINAL_CAR_CHUNKED_READBACK_VERIFIED',checkedAt:new Date().toISOString(),carSha256:EXPECTED,carBytes:EXPECTED_BYTES,partBytes:PART_BYTES,partsExpected:PARTS,partsVerified:verified,newPartsUploaded:uploaded,reusedExistingParts:reused,lastPartBytes:expectedPartBytes(PARTS-1),network:'private',privateMetadataMatched:true,allPartHashesVerified:true,fullReassemblyHashVerified:true,walletOperations:false,salesChanged:false,publicIpfsPublication:false,privateIdentifiersExposed:false};
  fs.mkdirSync('build/private-final-car',{recursive:true});fs.writeFileSync('build/private-final-car/storage-summary.json',JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary));
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
