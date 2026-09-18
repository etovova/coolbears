// PRIVATE-only content migration. Restore the exact historical CAR, replace only
// description, upload two new chunks and preserve all historical objects. No TON RPC.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {spawn} from 'node:child_process';import {pipeline} from 'node:stream/promises';
import {client,requireThat as check} from './pinata-backup-io.mjs';
const PACKAGE_SHA256='f4fb17938415afa7541e69463337565a0e3a0e7c73a1eb71d3b87582c8becd05';
const SOURCE='9b419a1d4642fd3e3b7d7ddcb1f27db6e25532b756634165a269ae0b76b02161';
const BYTES=12779698722,SOURCE_BYTES=12779698835,PART=256*1024*1024,COUNT=48;
const OLD='CoolBears v3 glasses-correction-1 FINAL CAR 28740649 part';
const bytes=fs.readFileSync('release/description-correction/unsigned-candidate.json'),p=JSON.parse(bytes),r=JSON.parse(fs.readFileSync('release/description-correction/publication-request.json')),s=JSON.parse(fs.readFileSync('release/launch-state.json'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
check(sha(bytes)===PACKAGE_SHA256&&r.packageSha256===PACKAGE_SHA256,'PACKAGE_BINDING_MISMATCH');
check(r.authorized===true&&r.action==='publish-approved-description-and-store-final-private','PRIVATE_WRITE_NOT_AUTHORIZED');
check(p.descriptionRevision==='approved-description-1'&&r.carSha256===p.releaseCarSha256&&r.manifestSha256===p.releaseManifestSha256&&r.carBytes===BYTES,'RELEASE_BINDING_MISMATCH');
check(s.phase==='hold'&&!s.mainnetVerified&&!s.creatorNftVerified&&!s.publicMintApproved&&!s.automaticRevealArmed,'PRODUCTION_MUST_REMAIN_HELD');
const PREFIX='CoolBears approved-description-1 FINAL CAR '+p.releaseCarSha256.slice(0,8)+' part';
const name=(prefix,i)=>`${prefix} ${String(i+1).padStart(3,'0')} of 048`;
const size=(i,bytes=BYTES)=>Math.min(PART,bytes-i*PART);
const sourceName=i=>name(i===0||i===COUNT-1?'CoolBears final-collection-branding-1 FINAL CAR 9b419a1d part':OLD,i);
const run=(command,args,capture=true)=>new Promise((resolve,reject)=>{const q=spawn(command,args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='';if(capture)q.stdout.on('data',b=>out+=b);q.stderr.on('data',()=>{});q.on('error',reject);q.on('close',c=>c===0?resolve(out):reject(Error('PRIVATE_SUBPROCESS_FAILED_'+c)));});
const hashFile=file=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),stream=fs.createReadStream(file);stream.on('data',b=>h.update(b));stream.on('error',reject);stream.on('end',()=>resolve(h.digest('hex')));});
const hashRange=(file,i)=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),stream=fs.createReadStream(file,{start:i*PART,end:i*PART+size(i)-1});stream.on('data',b=>h.update(b));stream.on('error',reject);stream.on('end',()=>resolve(h.digest('hex')));});
const jwt=process.env.PINATA_JWT;check(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const api=client(jwt),gateway=await api.gateway(process.env.PINATA_GATEWAY);
const rows=[];let token=null,pages=0;
do{const qs=new URLSearchParams({limit:'100'});if(token)qs.set('pageToken',token);const j=await api.api('/v3/files/private?'+qs);check(Array.isArray(j?.data?.files),'BAD_PRIVATE_LIST');rows.push(...j.data.files);token=j.data.next_page_token||null;check(++pages<=100,'TOO_MANY_PRIVATE_PAGES');}while(token);
const base=process.env.RUNNER_TEMP;check(base&&path.isAbsolute(base),'PRIVATE_TEMP_REQUIRED');
const tmp=fs.mkdtempSync(path.join(base,'coolbears-description-migration-')),car=path.join(tmp,'description-migration.car'),part=path.join(tmp,'part.bin'),readback=path.join(tmp,'readback.bin');
async function download(row,target){
 check(typeof row.id==='string'&&typeof row.cid==='string','MISSING_PRIVATE_IDENTIFIER');
 const meta=await api.api('/v3/files/private/'+encodeURIComponent(row.id));check(meta.data?.id===row.id&&meta.data?.cid===row.cid,'PRIVATE_METADATA_MISMATCH');
 const url=new URL(gateway).origin+'/files/'+row.cid;
 const response=await api.api('/v3/files/sign',{method:'POST',body:{url,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
 const link=typeof response.data==='string'?response.data:response.data?.url;check(typeof link==='string','NO_SIGNED_DOWNLOAD');
 const u=new URL(link),wanted=new URL(url);check(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_TARGET_MISMATCH');
 await run('curl',['--fail','--silent','--show-error','--location','--retry','5','--retry-all-errors','--retry-delay','3','--output',target,u.href],false);
}
async function upload(file,label){
 const output=await run('curl',['--silent','--show-error','--request','POST','https://uploads.pinata.cloud/v3/files','--header','Authorization: Bearer '+jwt,'--form','network=private','--form','name='+label,'--form','file=@'+file+';type=application/octet-stream','--write-out','\n%{http_code}']);
 const cut=output.lastIndexOf('\n'),code=Number(output.slice(cut+1));check(code>=200&&code<300,'PRIVATE_UPLOAD_HTTP_'+code);
 let j;try{j=JSON.parse(output.slice(0,cut));}catch{throw Error('PRIVATE_UPLOAD_RESPONSE_INVALID');}
 check(j.data?.id&&j.data?.cid&&(j.data.network??'private')==='private','PRIVATE_UPLOAD_RECEIPT_INVALID');return j.data;
}
let uploaded=0,reusedNew=0;const readbackHashes=[];
try{
 fs.writeFileSync(car,'',{flag:'wx',mode:0o600});fs.truncateSync(car,SOURCE_BYTES);
 let next=0;
 async function worker(){while(next<COUNT){
  const i=next++,file=path.join(tmp,'source-'+i+'.bin');
  const matches=rows.filter(x=>x.name===sourceName(i));check(matches.length===1,'SOURCE_PART_NOT_UNIQUE');
  await download(matches[0],file);check(fs.statSync(file).size===size(i,SOURCE_BYTES),'SOURCE_PART_SIZE_MISMATCH');
  readbackHashes[i]=await hashFile(file);
  await pipeline(fs.createReadStream(file),fs.createWriteStream(car,{flags:'r+',start:i*PART,mode:0o600}));fs.rmSync(file);
  console.log('PRIVATE_SOURCE_PART_READ',i+1,'/48');
 }}
 const restored=await Promise.allSettled(Array.from({length:4},worker));
 for(const result of restored)if(result.status==='rejected')throw result.reason;
 check(fs.statSync(car).size===SOURCE_BYTES&&(await hashFile(car))===SOURCE,'SOURCE_FULL_CAR_HASH_MISMATCH');
 const patchLog=await run('python3',['scripts/patch-stored-description.py','--car',car]);
 const patched=JSON.parse(patchLog.trim());check(patched.carSha256===p.releaseCarSha256&&patched.unchangedNfts===10000,'PATCH_VERIFICATION_FAILED');
 check((await hashFile(car))===p.releaseCarSha256,'PATCHED_CAR_HASH_MISMATCH');
 for(const i of [0,COUNT-1]){
  await pipeline(fs.createReadStream(car,{start:i*PART,end:i*PART+size(i)-1}),fs.createWriteStream(part,{flags:'wx',mode:0o600}));
  const label=name(PREFIX,i),matches=rows.filter(x=>x.name===label);check(matches.length<=1,'NEW_PART_NOT_UNIQUE');
  let row;if(matches.length){row=matches[0];reusedNew++;}else{row=await upload(part,label);uploaded++;rows.push(row);}
  await download(row,readback);check(fs.statSync(readback).size===size(i)&&(await hashFile(readback))===(await hashFile(part)),'NEW_PART_READBACK_MISMATCH');
  readbackHashes[i]=await hashFile(readback);
  fs.rmSync(part);fs.rmSync(readback);console.log('PRIVATE_DESCRIPTION_PART_READBACK_VERIFIED',i+1,'/48');
 }
 for(let i=0;i<COUNT;i++)check((await hashRange(car,i))===readbackHashes[i],'TARGET_PART_READBACK_HASH_MISMATCH');
 check((await hashFile(car))===p.releaseCarSha256,'FINAL_REASSEMBLY_HASH_MISMATCH');
 const report={schema:6,status:'PRIVATE_DESCRIPTION_FINAL_CAR_CHUNKED_READBACK_VERIFIED',checkedAt:new Date().toISOString(),collectionRevision:p.collectionRevision,finalBrandingRevision:p.finalBrandingRevision,descriptionRevision:p.descriptionRevision,packageSha256:PACKAGE_SHA256,manifestSha256:p.releaseManifestSha256,carSha256:p.releaseCarSha256,carBytes:BYTES,finalContentCommitment:p.finalContentCommitment,sourceCarSha256:SOURCE,sourcePartsDownloaded:48,partsExpected:48,partsVerified:48,newPartsUploaded:uploaded,reusedExistingParts:46+reusedNew,changedPartNumbers:[1,48],allPartHashesVerified:true,fullReassemblyHashVerified:true,readbackMethod:'46 unchanged middle parts freshly restored and source-hash verified; 2 corrected endpoint parts freshly downloaded and compared; full target CAR SHA verified',network:'private',privateIdentifiersExposed:false,publicIpfsPublication:false,transactionsSent:0,walletOperations:false,salesChanged:false};
 fs.mkdirSync('build/description-correction',{recursive:true});fs.writeFileSync('build/description-correction/storage-summary.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
