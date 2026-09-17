// Resume only the approved encrypted recovery archive. Not NFT publication.
import fs from 'node:fs';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {keys,unseal,seal,checkRequest,checkSource} from './pinata-private-recovery.mjs';
import {client,readBounded,digest,requireThat} from './pinata-backup-io.mjs';
const HASH='00c983a1af436b60008505ad3cd706615bd5a3e01cf1186a7127cbdde69f3252',SIZE=153849791,PART=41943040;
export function validateReceipt(r){
 requireThat(r.schema===1&&r.archiveSha256===HASH&&r.archiveBytes===SIZE&&r.encryption==='AES-256-GCM','UNEXPECTED_RECOVERY');
 requireThat(typeof r.key==='string'&&Buffer.from(r.key,'base64').length===32&&Array.isArray(r.parts)&&r.parts.length>=1&&r.parts.length<=4,'BAD_RECOVERY_KEY_OR_PARTS');
 let offset=0;for(let i=0;i<r.parts.length;i++){const p=r.parts[i];requireThat(p.index===i&&p.offset===offset&&p.bytes===Math.min(PART,SIZE-offset)&&p.network==='private','BAD_PART_SEQUENCE');offset+=p.bytes;}
 return offset;
}
export async function main(){
 const dir='build/pinata-completed-backup';fs.mkdirSync(dir,{recursive:true});let stage='receipt',r,k,summary;
 const save=()=>{if(r&&k)fs.writeFileSync(dir+'/receipt.sealed.json',JSON.stringify(seal(r,k.publicDer),null,2)+'\n');};
 try{
  const jwt=process.env.PINATA_JWT;k=keys(jwt);
  const receiptPath=fs.existsSync('release/pinata-recovery-complete.sealed.json')?'release/pinata-recovery-complete.sealed.json':'release/pinata-recovery-first-attempt.sealed.json';
  r=unseal(JSON.parse(fs.readFileSync(receiptPath)),k);let offset=validateReceipt(r);const oldCount=r.parts.length,readbacks=[];
  const api=client(jwt);stage='account-gateway';const gateway=await api.gateway(process.env.PINATA_GATEWAY);
  stage='verify-existing-parts';
  for(const p of r.parts){const v=await api.readPart(p,r.key,gateway);p.downloadVerified=true;p.metadataBytes=v.metadataSize;readbacks.push(v.clear);}save();
  if(offset<SIZE){
   requireThat(process.argv.includes('--resume')&&process.env.COOLBEARS_RESUME_PRIVATE==='1','RESUME_NOT_AUTHORIZED');
   stage='approved-source';const req=checkRequest(unseal(JSON.parse(fs.readFileSync('release/pinata-recovery-resume.sealed.json')),k));
   let url=req.url,response;for(let n=0;n<5;n++){checkSource(url);response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');requireThat(next,'EMPTY_REDIRECT');url=new URL(next,url).href;continue;}break;}
   const archive=await readBounded(response,SIZE);requireThat(archive.length===SIZE&&digest(archive)===HASH,'SOURCE_ARCHIVE_MISMATCH');
   requireThat(Buffer.concat(readbacks).equals(archive.subarray(0,offset)),'EXISTING_PARTS_DIFFER_FROM_SOURCE');
   while(offset<SIZE){
    const index=r.parts.length,data=archive.subarray(offset,Math.min(offset+PART,SIZE)),iv=crypto.randomBytes(12),aad=Buffer.from(`CoolBears/private-recovery-transfer/v1:${HASH}:${index}`),c=crypto.createCipheriv('aes-256-gcm',Buffer.from(r.key,'base64'),iv);c.setAAD(aad);const encrypted=Buffer.concat([c.update(data),c.final()]);
    stage='upload-missing-part-'+index;
    const form=new FormData();form.append('file',new Blob([encrypted],{type:'application/octet-stream'}),`CoolBears_v3_recovery.part${String(index+1).padStart(3,'0')}.cbenc`);form.append('network','private');form.append('name',`CoolBears v3 encrypted private recovery ${index+1}`);
    const response=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+jwt},body:form,redirect:'error',signal:AbortSignal.timeout(180000)});
    requireThat(response.ok,'PRIVATE_UPLOAD_HTTP_'+response.status);const f=(await response.json()).data;requireThat(f&&typeof f.id==='string'&&typeof f.cid==='string','UPLOAD_RECEIPT_MISSING');
    const part={index,offset,bytes:data.length,plaintextSha256:digest(data),ciphertextSha256:digest(encrypted),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),aad:aad.toString('base64'),fileId:f.id,cid:f.cid,network:f.network??null};r.parts.push(part);r.status='PARTIAL_READBACK';save();
    requireThat(part.network==='private','PRIVATE_NETWORK_NOT_CONFIRMED');
    stage='read-back-new-part-'+index;const v=await api.readPart(part,r.key,gateway);part.downloadVerified=true;part.metadataBytes=v.metadataSize;readbacks.push(v.clear);offset+=data.length;validateReceipt(r);save();
   }
  }
  stage='verify-full-recovered-archive';const recovered=Buffer.concat(readbacks);
  requireThat(recovered.length===SIZE&&digest(recovered)===HASH&&r.parts.every(p=>p.downloadVerified),'FULL_BACKUP_HASH_MISMATCH');
  r.status='PRIVATE_BACKUP_READBACK_VERIFIED';r.verifiedAt=new Date().toISOString();save();
  summary={schema:1,status:r.status,checkedAt:r.verifiedAt,archiveSha256:HASH,archiveBytes:SIZE,partsVerified:r.parts.length,newPartsUploaded:r.parts.length-oldCount,reusedExistingParts:oldCount,network:'private',clientSideEncrypted:true,allCiphertextAndPlaintextHashesVerified:true,completeRecoveryBackup:true,final10000ImagesPublished:false,fullCollectionStorageVerified:false,mainnetReady:false};
  console.log(JSON.stringify(summary));
 }catch(e){save();const code=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRIVATE_BACKUP_ERROR';summary={schema:1,status:'NOT_COMPLETED',stage,error:code,partsRecorded:r?.parts?.length??0,completeRecoveryBackup:false,mainnetReady:false};console.error(JSON.stringify(summary));process.exitCode=1;}
 finally{fs.writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2)+'\n');}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
