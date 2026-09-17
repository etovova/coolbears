// Restore to a private runner directory only; never upload decrypted content.
import fs from 'node:fs';import path from 'node:path';
import {keys,unseal} from './pinata-private-recovery.mjs';
import {client,digest,requireThat} from './pinata-backup-io.mjs';
import {validateReceipt} from './finish-pinata-private-recovery.mjs';
const base=process.env.RUNNER_TEMP;
requireThat(base&&path.isAbsolute(base),'PRIVATE_TEMP_DIRECTORY_REQUIRED');
const dir=path.join(base,'coolbears-verified-recovery');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
let stage='receipt';
try{
 const k=keys(process.env.PINATA_JWT),r=unseal(JSON.parse(fs.readFileSync('release/pinata-recovery-complete.sealed.json')),k);
 requireThat(validateReceipt(r)===153849791&&r.parts.length===4&&r.status==='PRIVATE_BACKUP_READBACK_VERIFIED','COMPLETE_RECEIPT_REQUIRED');
 const api=client(process.env.PINATA_JWT);stage='gateway';const gateway=await api.gateway(process.env.PINATA_GATEWAY);
 const parts=[];stage='download-and-authenticate';for(const p of r.parts){const got=await api.readPart(p,r.key,gateway);parts.push(got.clear);}
 const archive=Buffer.concat(parts);requireThat(archive.length===r.archiveBytes&&digest(archive)===r.archiveSha256,'RESTORE_HASH_MISMATCH');
 fs.writeFileSync(path.join(dir,'recovery.zip'),archive,{flag:'wx',mode:0o600});
 console.log('PRIVATE_RECOVERY_RESTORED_AND_HASH_VERIFIED',archive.length);
}catch(e){console.error(JSON.stringify({status:'RESTORE_FAILED',stage,error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRIVATE_READ_ERROR'}));process.exitCode=1;}
