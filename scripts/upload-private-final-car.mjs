// Store the hash-verified corrected final CAR as fixed private Pinata chunks.
// Each chunk is independently downloaded and SHA-256 verified; all readbacks are
// rehashed in order to prove byte-for-byte reconstruction of the original CAR.
// Pinata metadata size is informational only; downloaded bytes are authoritative.
// Private file IDs, CIDs, signed URLs and secrets are never logged.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {client,requireThat} from './pinata-backup-io.mjs';

const REVISION='v3-glasses-correction-1';
const EXPECTED='287406498c91a1791880bef7919a58c61e55a7dfd884aeb57c22a8ab49115b84';
const EXPECTED_BYTES=12779698835;
const PART_BYTES=256*1024*1024;
const PARTS=Math.ceil(EXPECTED_BYTES/PART_BYTES);
const PREFIX='CoolBears v3 glasses-correction-1 FINAL CAR 28740649 part';
const partName=i=>`${PREFIX} ${String(i+1).padStart(3,'0')} of ${String(PARTS).padStart(3,'0')}`;
const expectedPartBytes=i=>Math.min(PART_BYTES,EXPECTED_BYTES-i*PART_BYTES);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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
  let lastCode=0;
  for(let attempt=1;attempt<=6;attempt++){
    const out=await runCurl(['--silent','--show-error','--request','POST','https://uploads.pinata.cloud/v3/files','--header','Authorization: Bearer '+jwt,'--form','network=private','--form','name='+name,'--form','file=@'+partFile+';type=application/octet-stream','--write-out','\n%{http_code}']);
    const cut=out.lastIndexOf('\n');requireThat(cut>=0,'UPLOAD_STATUS_MISSING');
    const code=Number(out.slice(cut+1).trim());lastCode=code;
    if(Number.isInteger(code)&&code>=200&&code<300){
      let parsed;try{parsed=JSON.parse(out.slice(0,cut))}catch{throw Error('UPLOAD_RESPONSE_NOT_JSON')}
      const f=parsed?.data;requireThat(f&&typeof f.id==='string'&&typeof f.cid==='string','UPLOAD_RECEIPT_MISSING');return f;
    }
    if(![429,500,502,503,504].includes(code)||attempt===6)throw Error('PRIVATE_PART_UPLOAD_HTTP_'+code);
    console.log(`PRIVATE_PART_UPLOAD_RETRY ${attempt}/6 HTTP_${code}`);await sleep(Math.min(60000,5000*attempt));
  }
  throw Error('PRIVATE_PART_UPLOAD_HTTP_'+lastCode);
}
async function signedDownload(api,gateway,row,target){
  requireThat(typeof row.id==='string'&&typeof row.cid==='string','PRIVATE_PART_IDENTIFIER_MISSING');
  const meta=await api.api('/v3/files/private/'+encodeURIComponent(row.id));
  requireThat(meta.data?.id===row.id&&meta.data?.cid===row.cid,'PRIVATE_PART_METADATA_MISMATCH');
  const url=new URL(gateway).origin+'/files/'+row.cid;
  const signed=await api.api('/v3/files/sign',{method:'POST',body:{url,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
  const link=typeof signed.data==='string'?signed.data:signed.data?.url;requireThat(typeof link==='string','NO_SIGNED_PART_DOWNLOAD');
  const u=new URL(link),wanted=new URL(url);requireThat(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_PART_TARGET_MISMATCH');
  await runCurl(['--fail','--silent','--show-error','--location','--retry','8','--retry-all-errors','--retry-delay','5','--output',target,u.href],{capture:false});
}
async function listAllPrivate(api){
  const all=[];let token=null,pages=0;
  do{
    const qs=new URLSearchParams({limit:'100'});if(token)qs.set('pageToken',token);
    const j=await api.api('/v3/files/private?'+qs.toString());
    requireThat(Array.isArray(j?.data?.files),'PRIVATE_LIST_SHAPE_MISMATCH');
    all.push(...j.data.files);token=j.data.next_page_token||null;pages++;
    requireThat(pages<=100,'PRIVATE_LIST_TOO_MANY_PAGES');
  }while(token);
  return {rows:all,pages};
}

const carPath=fs.readFileSync('build/private-final-car/car-path.txt','utf8').trim();
requireThat(fs.existsSync(carPath),'CAR_NOT_FOUND');
requireThat(fs.statSync(carPath).size===EXPECTED_BYTES,'PREUPLOAD_CAR_SIZE_MISMATCH');
requireThat((await hashFile(carPath))===EXPECTED,'PREUPLOAD_CAR_HASH_MISMATCH');
requireThat(PARTS===48&&expectedPartBytes(PARTS-1)===163232403,'PARTITION_POLICY_MISMATCH');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const api=client(jwt),gateway=await api.gateway(process.env.PINATA_GATEWAY);
const listing=await listAllPrivate(api),rows=listing.rows;
console.log(`PRIVATE_LIST_PAGES_SCANNED ${listing.pages}`);

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
      row=existing[0];reused++;
    }else{
      row=await uploadPart(jwt,partFile,name);requireThat((row.network??'private')==='private','PRIVATE_PART_NETWORK_NOT_CONFIRMED');uploaded++;rows.push(row);
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
  const summary={schema:5,status:'PRIVATE_CORRECTED_FINAL_CAR_CHUNKED_READBACK_VERIFIED',collectionRevision:REVISION,checkedAt:new Date().toISOString(),carSha256:EXPECTED,carBytes:EXPECTED_BYTES,partBytes:PART_BYTES,partsExpected:PARTS,partsVerified:verified,newPartsUploaded:uploaded,reusedExistingParts:reused,lastPartBytes:expectedPartBytes(PARTS-1),privateListPagesScanned:listing.pages,network:'private',privateMetadataMatched:true,pinataSizeMetadataTrusted:false,allPartHashesVerified:true,fullReassemblyHashVerified:true,walletOperations:false,salesChanged:false,publicIpfsPublication:false,privateIdentifiersExposed:false};
  fs.mkdirSync('build/private-final-car',{recursive:true});fs.writeFileSync('build/private-final-car/storage-summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
