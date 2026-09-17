// Publish the exact already-verified PRIVATE final CAR to PUBLIC Pinata at reveal time,
// then prove representative final metadata + PNG bytes are public before on-chain reveal.
// Nonscheduled prepare-only mode performs no network request and no upload.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {client,requireThat} from './pinata-backup-io.mjs';

const PACKAGE_SHA='10aff272f0be8b315f7c280539ed49483c7bdf2f7a545863064d29fffcb008fa';
const CAR_SHA='3d6377484e3d27361c367be7b002a065d83426342df30f25e1d681b4d50f820c';
const REVEAL_AT=1798761600;
const NAME='CoolBears v3 FINAL CAR private verified';
const SAMPLE=[0,1,4979,9999];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hashFile=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const runCurl=(args,{capture=true}={})=>new Promise((resolve,reject)=>{const p=spawn('curl',args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='',err='';if(capture)p.stdout.on('data',b=>{out+=b});p.stderr.on('data',b=>{err+=b});p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error('CURL_FAILED_'+c)));});
const mode=process.argv.includes('--publish')?'publish':'prepare-only';

const candidateBytes=fs.readFileSync('launch/candidate.json');
const candidate=JSON.parse(candidateBytes);
requireThat(sha(candidateBytes)===PACKAGE_SHA,'CANDIDATE_SHA_MISMATCH');
requireThat(candidate.releaseCarSha256===CAR_SHA,'CANDIDATE_CAR_SHA_MISMATCH');
requireThat(candidate.revealAt===REVEAL_AT,'REVEAL_DATE_MISMATCH');
const recoveryDir=path.join(process.env.RUNNER_TEMP,'coolbears-verified-recovery');
const reveal=JSON.parse(fs.readFileSync(path.join(recoveryDir,'reveal.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(recoveryDir,'manifest.json')));
requireThat(reveal.carSha256===CAR_SHA&&reveal.bundleCid===manifest.bundleCid,'PRIVATE_REVEAL_CAR_BINDING_MISMATCH');
requireThat(manifest.revision==='v3'&&manifest.images===10000&&manifest.metadata===10000&&Array.isArray(manifest.records)&&manifest.records.length===10000,'PRIVATE_MANIFEST_POLICY_MISMATCH');
requireThat(typeof manifest.metadataRootIpfs==='string'&&manifest.metadataRootIpfs.startsWith('ipfs://'),'FINAL_METADATA_ROOT_MISSING');
for(const id of SAMPLE){const r=manifest.records[id];requireThat(r?.id===id&&/^[a-f0-9]{64}$/.test(r.metadataSha256)&&/^[a-f0-9]{64}$/.test(r.pngSha256)&&typeof r.imageCid==='string','SAMPLE_MANIFEST_RECORD_INVALID');}

const outDir='build/automatic-reveal';fs.mkdirSync(outDir,{recursive:true});
if(mode==='prepare-only'){
 const result={schema:1,status:'FINAL_PUBLICATION_GATE_PREPARED',mode,packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,revealAt:REVEAL_AT,sampleRecordsChecked:SAMPLE.length,networkRequests:0,uploadsPerformed:false,privateIdsExposed:false,privateCidsExposed:false};
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
 const rest=uri.slice(7).replace(/^\/+/, '');
 requireThat(/^[A-Za-z0-9]+(?:\/.*)?$/.test(rest),'BAD_IPFS_PATH');
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

// A retry after a successful import must not upload a duplicate.
if(await verifyPublicSample()){
 const result={schema:1,status:'FINAL_PUBLIC_CONTENT_ALREADY_VERIFIED',packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,sampleMetadataAndImagesVerified:SAMPLE.length,publicReady:true,uploadedNow:false,privateIdsExposed:false,privateCidsExposed:false};
 fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exit(0);
}

const api=client(jwt);
const listing=await api.api('/v3/files/private?limit=100');
const rows=listing?.data?.files;
requireThat(Array.isArray(rows),'PRIVATE_FILE_LIST_SHAPE_MISMATCH');
const matches=rows.filter(x=>x?.name===NAME&&Number(x?.size||0)>10_000_000_000&&typeof x?.id==='string'&&typeof x?.cid==='string');
requireThat(matches.length===1,'PRIVATE_FINAL_CAR_NOT_UNIQUE');
const f=matches[0];
const meta=await api.api('/v3/files/private/'+encodeURIComponent(f.id));
requireThat(meta.data?.id===f.id&&meta.data?.cid===f.cid&&meta.data?.name===NAME,'PRIVATE_FINAL_CAR_METADATA_MISMATCH');
const gateway=await api.gateway(process.env.PINATA_GATEWAY);
const privateUrl=new URL(gateway).origin+'/files/'+f.cid;
const signed=await api.api('/v3/files/sign',{method:'POST',body:{url:privateUrl,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
const link=typeof signed.data==='string'?signed.data:signed.data?.url;requireThat(typeof link==='string','NO_SIGNED_PRIVATE_CAR_DOWNLOAD');
const su=new URL(link),wanted=new URL(privateUrl);requireThat(su.origin===wanted.origin&&su.pathname===wanted.pathname&&!su.username&&!su.password,'SIGNED_PRIVATE_TARGET_MISMATCH');
const car=path.join(process.env.RUNNER_TEMP,'CoolBears_v3_FINAL_for_public_reveal.car');
await runCurl(['--fail','--silent','--show-error','--location','--retry','5','--retry-delay','5','--output',car,su.href],{capture:false});
requireThat((await hashFile(car))===CAR_SHA,'PRIVATE_CAR_DOWNLOAD_HASH_MISMATCH');

const upload=await runCurl(['--fail-with-body','--silent','--show-error','--request','POST','https://uploads.pinata.cloud/v3/files','--header','Authorization: Bearer '+jwt,'--form','network=public','--form','name=CoolBears v3 FINAL reveal bundle','--form','car=true','--form','file=@'+car+';type=application/vnd.ipld.car']);
fs.rmSync(car,{force:true});
let parsed;try{parsed=JSON.parse(upload)}catch{throw Error('PUBLIC_CAR_UPLOAD_RESPONSE_NOT_JSON')}
const pub=parsed?.data;requireThat(pub&&typeof pub.cid==='string','PUBLIC_CAR_UPLOAD_RECEIPT_MISSING');
requireThat(pub.cid===manifest.bundleCid,'PUBLIC_CAR_ROOT_CID_MISMATCH');

let ready=false;
for(let i=0;i<30;i++){
 if(await verifyPublicSample()){ready=true;break;}
 await new Promise(r=>setTimeout(r,10000));
}
requireThat(ready,'PUBLIC_FINAL_CONTENT_NOT_GATEWAY_VERIFIED');
const result={schema:1,status:'FINAL_PUBLIC_CAR_IMPORTED_AND_GATEWAY_VERIFIED',packageSha256:PACKAGE_SHA,carSha256:CAR_SHA,sampleMetadataAndImagesVerified:SAMPLE.length,publicReady:true,uploadedNow:true,rootCidMatchedPrivateManifest:true,privateIdsExposed:false,privateCidsExposed:false};
fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
