// Jan 1 reveal publication gate.
// 1) prove the frozen candidate/reveal binding;
// 2) reconstruct the exact final CAR from all 48 verified PRIVATE Pinata chunks;
// 3) require exact byte count + committed CAR SHA-256;
// 4) publish that CAR to PUBLIC Pinata using resumable TUS;
// 5) require the public root CID and real metadata+PNG bytes to match the private manifest;
// Only after this script succeeds may automatic-reveal.mjs broadcast the on-chain reveal.
// Nonscheduled prepare-only mode performs zero Pinata/public-network requests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {client,requireThat} from './pinata-backup-io.mjs';

const PACKAGE_SHA='10aff272f0be8b315f7c280539ed49483c7bdf2f7a545863064d29fffcb008fa';
const CAR_SHA='3d6377484e3d27361c367be7b002a065d83426342df30f25e1d681b4d50f820c';
const CAR_BYTES=12781754123;
const PART_BYTES=256*1024*1024;
const PARTS=48;
const PREFIX='CoolBears v3 FINAL CAR 3d637748 part';
const PUBLIC_NAME='CoolBears v3 FINAL reveal bundle';
const REVEAL_AT=1798761600;
const SAMPLE=[0,1,4979,9999];
const partName=i=>`${PREFIX} ${String(i+1).padStart(3,'0')} of ${String(PARTS).padStart(3,'0')}`;
const expectedPartBytes=i=>Math.min(PART_BYTES,CAR_BYTES-i*PART_BYTES);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hashFile=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const runCurl=(args,{capture=true}={})=>new Promise((resolve,reject)=>{const p=spawn('curl',args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='';if(capture)p.stdout.on('data',b=>{out+=b});p.stderr.on('data',()=>{});p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error('CURL_FAILED_'+c)));});
const enc=v=>Buffer.from(v,'utf8').toString('base64');
const mode=process.argv.includes('--publish')?'publish':'prepare-only';

const candidateBytes=fs.readFileSync('launch/candidate.json');
const candidate=JSON.parse(candidateBytes);
requireThat(sha(candidateBytes)===PACKAGE_SHA,'CANDIDATE_SHA_MISMATCH');
requireThat(candidate.releaseCarSha256===CAR_SHA,'CANDIDATE_CAR_SHA_MISMATCH');
requireThat(candidate.revealAt===REVEAL_AT,'REVEAL_DATE_MISMATCH');
requireThat(PARTS===Math.ceil(CAR_BYTES/PART_BYTES)&&expectedPartBytes(PARTS-1)===165287691,'PRIVATE_PARTITION_POLICY_MISMATCH');

const recoveryDir=path.join(process.env.RUNNER_TEMP,'coolbears-verified-recovery');
const reveal=JSON.parse(fs.readFileSync(path.join(recoveryDir,'reveal.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(recoveryDir,'manifest.json')));
requireThat(reveal.carSha256===CAR_SHA&&reveal.bundleCid===manifest.bundleCid,'PRIVATE_REVEAL_CAR_BINDING_MISMATCH');
requireThat(manifest.revision==='v3'&&manifest.images===10000&&manifest.metadata===10000&&Array.isArray(manifest.records)&&manifest.records.length===10000,'PRIVATE_MANIFEST_POLICY_MISMATCH');
requireThat(typeof manifest.metadataRootIpfs==='string'&&manifest.metadataRootIpfs.startsWith('ipfs://'),'FINAL_METADATA_ROOT_MISSING');
for(const id of SAMPLE){const r=manifest.records[id];requireThat(r?.id===id&&/^[a-f0-9]{64}$/.test(r.metadataSha256)&&/^[a-f0-9]{64}$/.test(r.pngSha256)&&typeof r.imageCid==='string','SAMPLE_MANIFEST_RECORD_INVALID');}

const outDir='build/automatic-reveal';fs.mkdirSync(outDir,{recursive:true});
if(mode==='prepare-only'){
 const result={schema:2,status:'FINAL_PUBLICATION_GATE_PREPARED',mode,packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,carBytes:CAR_BYTES,privatePartsRequired:PARTS,revealAt:REVEAL_AT,sampleRecordsChecked:SAMPLE.length,publicationOrder:['reconstruct-private-car','verify-car-sha256','public-tus-upload','verify-public-root-cid','verify-public-metadata-and-png','allow-onchain-reveal'],networkRequests:0,uploadsPerformed:false,privateIdsExposed:false,privateCidsExposed:false};
 fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exit(0);
}

const state=JSON.parse(fs.readFileSync('release/launch-state.json'));
const now=Math.floor(Date.now()/1000),year=new Date().getUTCFullYear();
requireThat(year===2027&&now>=REVEAL_AT,'PUBLICATION_TOO_EARLY');
requireThat(state.automaticRevealArmed===true&&state.privateStorageVerified===true&&state.mainnetVerified===true&&state.creatorNftVerified===true,'PUBLICATION_NOT_ARMED');
requireThat(state.packageSha256===PACKAGE_SHA,'ARMED_PACKAGE_MISMATCH');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');

function publicUrl(uri){
 requireThat(typeof uri==='string'&&uri.startsWith('ipfs://'),'BAD_IPFS_URI');
 const rest=uri.slice(7).replace(/^\/+/, '');requireThat(/^[A-Za-z0-9]+(?:\/.*)?$/.test(rest),'BAD_IPFS_PATH');
 return 'https://gateway.pinata.cloud/ipfs/'+rest;
}
async function fetchBounded(url,limit){
 const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(60000)});requireThat(r.ok,'PUBLIC_GATEWAY_HTTP_'+r.status);
 const chunks=[];let n=0;for await(const b of r.body){n+=b.length;requireThat(n<=limit,'PUBLIC_OBJECT_TOO_LARGE');chunks.push(b);}return Buffer.concat(chunks);
}
async function verifyPublicSample(){
 try{
  for(const id of SAMPLE){
   const rec=manifest.records[id];
   const murl=publicUrl(manifest.metadataRootIpfs)+(manifest.metadataRootIpfs.endsWith('/')?'':'/')+String(id).padStart(4,'0')+'.json';
   const mb=await fetchBounded(murl,2_000_000);if(sha(mb)!==rec.metadataSha256)return false;
   const m=JSON.parse(mb.toString('utf8'));if(m.image!=='ipfs://'+rec.imageCid)return false;
   const ib=await fetchBounded(publicUrl(m.image),25_000_000);if(sha(ib)!==rec.pngSha256)return false;
  }
  return true;
 }catch{return false;}
}

// On a retry, if representative committed final objects are already publicly retrievable
// byte-for-byte, do not upload a duplicate CAR.
if(await verifyPublicSample()){
 const result={schema:2,status:'FINAL_PUBLIC_CONTENT_ALREADY_VERIFIED',packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,sampleMetadataAndImagesVerified:SAMPLE.length,publicReady:true,uploadedNow:false,onChainRevealAllowed:true,privateIdsExposed:false,privateCidsExposed:false};
 fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exit(0);
}

const api=client(jwt);
const privateListing=await api.api('/v3/files/private?limit=100');
const rows=privateListing?.data?.files;requireThat(Array.isArray(rows),'PRIVATE_FILE_LIST_SHAPE_MISMATCH');
requireThat(!privateListing.data.next_page_token,'PRIVATE_LIST_UNEXPECTED_PAGINATION');
const gateway=await api.gateway(process.env.PINATA_GATEWAY);
const car=path.join(process.env.RUNNER_TEMP,'CoolBears_v3_FINAL_for_public_reveal.car');
const partTmp=path.join(process.env.RUNNER_TEMP,'CoolBears_v3_FINAL_for_public_reveal.part');
fs.rmSync(car,{force:true});fs.rmSync(partTmp,{force:true});
const totalHash=crypto.createHash('sha256');let total=0;
try{
 for(let i=0;i<PARTS;i++){
  const name=partName(i),matches=rows.filter(x=>x?.name===name);requireThat(matches.length===1,'PRIVATE_FINAL_CAR_PART_NOT_UNIQUE');
  const row=matches[0];requireThat(typeof row.id==='string'&&typeof row.cid==='string','PRIVATE_PART_IDENTIFIER_MISSING');
  requireThat(Number(row.size)===expectedPartBytes(i),'PRIVATE_FINAL_CAR_PART_SIZE_MISMATCH');
  const meta=await api.api('/v3/files/private/'+encodeURIComponent(row.id));
  requireThat(meta.data?.id===row.id&&meta.data?.cid===row.cid&&meta.data?.name===name&&Number(meta.data?.size)===expectedPartBytes(i),'PRIVATE_PART_METADATA_MISMATCH');
  const privateUrl=new URL(gateway).origin+'/files/'+row.cid;
  const signed=await api.api('/v3/files/sign',{method:'POST',body:{url:privateUrl,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
  const link=typeof signed.data==='string'?signed.data:signed.data?.url;requireThat(typeof link==='string','NO_SIGNED_PART_DOWNLOAD');
  const su=new URL(link),wanted=new URL(privateUrl);requireThat(su.origin===wanted.origin&&su.pathname===wanted.pathname&&!su.username&&!su.password,'SIGNED_PART_TARGET_MISMATCH');
  await runCurl(['--fail','--silent','--show-error','--location','--retry','5','--retry-delay','3','--output',partTmp,su.href],{capture:false});
  requireThat(fs.statSync(partTmp).size===expectedPartBytes(i),'PRIVATE_PART_READBACK_SIZE_MISMATCH');
  await new Promise((resolve,reject)=>{const r=fs.createReadStream(partTmp),w=fs.createWriteStream(car,{flags:i===0?'w':'a',mode:0o600});r.on('data',b=>totalHash.update(b));r.on('error',reject);w.on('error',reject);w.on('finish',resolve);r.pipe(w);});
  total+=fs.statSync(partTmp).size;fs.rmSync(partTmp,{force:true});
  console.log(`REVEAL_PRIVATE_CAR_PART_RECONSTRUCTED ${i+1}/${PARTS}`);
 }
 requireThat(total===CAR_BYTES&&fs.statSync(car).size===CAR_BYTES,'PRIVATE_CAR_RECONSTRUCTED_SIZE_MISMATCH');
 requireThat(totalHash.digest('hex')===CAR_SHA,'PRIVATE_CAR_RECONSTRUCTED_STREAM_HASH_MISMATCH');
 requireThat((await hashFile(car))===CAR_SHA,'PRIVATE_CAR_RECONSTRUCTED_FILE_HASH_MISMATCH');

 // A completed TUS import may be listed before the public gateway has propagated.
 // Reuse it only if its committed root CID is exact; never create a duplicate.
 const publicListing=await api.api('/v3/files/public?limit=100');
 const prows=publicListing?.data?.files;requireThat(Array.isArray(prows),'PUBLIC_LIST_SHAPE_MISMATCH');
 const existing=prows.filter(x=>x?.name===PUBLIC_NAME);requireThat(existing.length<=1,'PUBLIC_FINAL_CAR_DUPLICATE');
 let uploadedNow=false;
 if(existing.length===1){requireThat(existing[0].cid===manifest.bundleCid,'EXISTING_PUBLIC_CAR_ROOT_CID_MISMATCH');}
 else {
  const meta=`filename ${enc('CoolBears_v3_FINAL_reveal.car')},network ${enc('public')},name ${enc(PUBLIC_NAME)},car ${enc('true')}`;
  const create=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Length':String(CAR_BYTES),'Upload-Metadata':meta},redirect:'manual',signal:AbortSignal.timeout(30000)});
  requireThat(create.status===201,'TUS_PUBLIC_CAR_CREATE_HTTP_'+create.status);
  const loc=create.headers.get('location');requireThat(loc,'TUS_PUBLIC_CAR_LOCATION_MISSING');
  const tus=new URL(loc,'https://uploads.pinata.cloud/v3/files');requireThat(tus.protocol==='https:'&&tus.hostname==='uploads.pinata.cloud'&&!tus.username&&!tus.password,'TUS_PUBLIC_CAR_LOCATION_UNTRUSTED');
  let offset=0,part=0;
  while(offset<CAR_BYTES){
   const target=Math.min(offset+PART_BYTES,CAR_BYTES),length=target-offset;let done=false;
   for(let attempt=0;attempt<5&&!done;attempt++){
    try{
     const body=fs.createReadStream(car,{start:offset,end:target-1});
     const patch=await fetch(tus.href,{method:'PATCH',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream','Content-Length':String(length)},body,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(900000)});
     requireThat(patch.status===204,'TUS_PUBLIC_CAR_PATCH_HTTP_'+patch.status);
     requireThat(Number(patch.headers.get('upload-offset'))===target,'TUS_PUBLIC_CAR_OFFSET_MISMATCH');done=true;
    }catch(e){
     const head=await fetch(tus.href,{method:'HEAD',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0'},redirect:'manual',signal:AbortSignal.timeout(30000)});
     requireThat(head.ok||head.status===204,'TUS_PUBLIC_CAR_HEAD_HTTP_'+head.status);const remote=Number(head.headers.get('upload-offset'));
     if(remote===target){done=true;break}requireThat(remote===offset,'TUS_PUBLIC_CAR_REMOTE_OFFSET_UNEXPECTED');if(attempt===4)throw e;
     await new Promise(r=>setTimeout(r,3000*(attempt+1)));
    }
   }
   requireThat(done,'TUS_PUBLIC_CAR_PART_NOT_CONFIRMED');offset=target;part++;console.log(`PUBLIC_FINAL_CAR_TUS_PART_CONFIRMED ${part}/${PARTS}`);
  }
  requireThat(offset===CAR_BYTES,'TUS_PUBLIC_CAR_FINAL_OFFSET_MISMATCH');uploadedNow=true;
  let found=null;
  for(let i=0;i<180;i++){
   const list=await api.api('/v3/files/public?limit=100');const rr=list?.data?.files;requireThat(Array.isArray(rr),'PUBLIC_LIST_SHAPE_MISMATCH');
   const hits=rr.filter(x=>x?.name===PUBLIC_NAME);requireThat(hits.length<=1,'PUBLIC_FINAL_CAR_DUPLICATE');if(hits.length===1){found=hits[0];break}await new Promise(r=>setTimeout(r,2000));
  }
  requireThat(found,'PUBLIC_FINAL_CAR_NOT_LISTED_AFTER_TUS');requireThat(found.cid===manifest.bundleCid,'PUBLIC_CAR_ROOT_CID_MISMATCH');
 }

 let ready=false;
 for(let i=0;i<60;i++){if(await verifyPublicSample()){ready=true;break}await new Promise(r=>setTimeout(r,10000));}
 requireThat(ready,'PUBLIC_FINAL_CONTENT_NOT_GATEWAY_VERIFIED');
 const result={schema:2,status:'FINAL_PUBLIC_CAR_AND_OBJECTS_GATEWAY_VERIFIED',packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,carBytes:CAR_BYTES,privatePartsReconstructed:PARTS,privateCarFullHashVerified:true,publicTusUploadVerified:true,publicRootCidMatchedPrivateManifest:true,sampleMetadataAndImagesVerified:SAMPLE.length,publicReady:true,uploadedNow,onChainRevealAllowed:true,privateIdsExposed:false,privateCidsExposed:false};
 fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {fs.rmSync(partTmp,{force:true});fs.rmSync(car,{force:true});}
