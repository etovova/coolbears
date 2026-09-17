// Read-back verification of the one already uploaded PRIVATE encrypted part.
import fs from 'node:fs';import {keys,unseal,seal} from './pinata-private-recovery.mjs';import {client,requireThat} from './pinata-backup-io.mjs';
const dir='build/pinata-readback';fs.mkdirSync(dir,{recursive:true});let stage='read-encrypted-receipt';
try{
 const k=keys(process.env.PINATA_JWT),r=unseal(JSON.parse(fs.readFileSync('release/pinata-recovery-first-attempt.sealed.json')),k);
 requireThat(r.parts.length===1&&r.parts[0].index===0,'UNEXPECTED_PARTIAL_RECEIPT');
 const api=client(process.env.PINATA_JWT);stage='account-gateway';const gateway=await api.gateway(process.env.PINATA_GATEWAY);
 stage='read-and-decrypt-part';const v=await api.readPart(r.parts[0],r.key,gateway);
 const result={schema:1,status:'FIRST_PRIVATE_PART_READBACK_VERIFIED',checkedAt:new Date().toISOString(),expectedBytes:r.parts[0].bytes,downloadedBytes:v.downloadedBytes,reportedMetadataBytes:v.metadataSize,ciphertextSha256Verified:true,plaintextSha256Verified:true,aesGcmVerified:true,newFilesUploaded:0,completeBackup:false};
 fs.writeFileSync(dir+'/summary.json',JSON.stringify(result,null,2)+'\n');
 fs.writeFileSync(dir+'/gateway.sealed.json',JSON.stringify(seal({gateway},k.publicDer),null,2)+'\n');console.log(JSON.stringify(result));
}catch(e){const code=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRIVATE_READBACK_FAILED';const result={schema:1,status:'NOT_VERIFIED',stage,error:code,newFilesUploaded:0,completeBackup:false};fs.writeFileSync(dir+'/summary.json',JSON.stringify(result,null,2)+'\n');console.error(JSON.stringify(result));process.exitCode=1;}
