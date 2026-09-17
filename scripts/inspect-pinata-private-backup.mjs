// Read metadata for exactly the uploaded encrypted recovery part. No uploads.
import fs from 'node:fs';import {keys,unseal,seal} from './pinata-private-recovery.mjs';
const k=keys(process.env.PINATA_JWT),receipt=unseal(JSON.parse(fs.readFileSync('release/pinata-recovery-first-attempt.sealed.json')),k);
const p=receipt.parts[0];if(!p||receipt.parts.length!==1)throw Error('Expected the recorded first upload');
const url='https://api.pinata.cloud/v3/files/private/'+encodeURIComponent(p.fileId);
const r=await fetch(url,{headers:{Authorization:'Bearer '+process.env.PINATA_JWT},redirect:'error',signal:AbortSignal.timeout(30000)});
const j=await r.json();const f=j.data;const summary={httpStatus:r.status,expectedEncryptedBytes:p.bytes,reportedBytes:f?.size,network:f?.network,fileIdMatches:f?.id===p.fileId,cidMatches:f?.cid===p.cid,fieldNames:Object.keys(f||{}),newFilesUploaded:0};
fs.mkdirSync('build/pinata-private-inspection',{recursive:true});
fs.writeFileSync('build/pinata-private-inspection/summary.json',JSON.stringify(summary,null,2));
fs.writeFileSync('build/pinata-private-inspection/metadata.sealed.json',JSON.stringify(seal(j,k.publicDer),null,2));
console.log(JSON.stringify(summary));if(!r.ok)process.exitCode=1;
