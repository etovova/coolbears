// Transfer the already approved recovery archive into PRIVATE Pinata storage.
// The download URL is sealed; only the public encryption key leaves Actions.
// Every uploaded part is additionally encrypted. No final artwork is published.
import fs from 'node:fs';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
const CONTEXT='CoolBears/private-recovery-transfer/v1';
const ARCHIVE_HASH='00c983a1af436b60008505ad3cd706615bd5a3e01cf1186a7127cbdde69f3252';
const ARCHIVE_SIZE=153849791;
const check=(ok,code)=>{if(!ok)throw Error(code);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export function keys(secret){
 check(typeof secret==='string'&&secret.length>=32,'PINATA_SECRET_MISSING');
 const seed=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(secret),Buffer.from(CONTEXT),Buffer.from('x25519-recipient'),32));
 const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),seed]),format:'der',type:'pkcs8'});
 const publicKey=crypto.createPublicKey(privateKey),pub=publicKey.export({format:'der',type:'spki'});
 return {privateKey,publicKey,keyId:sha(pub),publicDer:pub.toString('base64')};
}
export function seal(value,publicDer){
 const recipient=crypto.createPublicKey({key:Buffer.from(publicDer,'base64'),format:'der',type:'spki'});
 const eph=crypto.generateKeyPairSync('x25519'),salt=crypto.randomBytes(32),iv=crypto.randomBytes(12);
 const key=Buffer.from(crypto.hkdfSync('sha256',crypto.diffieHellman({privateKey:eph.privateKey,publicKey:recipient}),salt,Buffer.from(CONTEXT),32));
 const c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(CONTEXT));const b=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);
 return {schema:1,algorithm:'X25519-HKDF-SHA256-AES256GCM',keyId:sha(recipient.export({format:'der',type:'spki'})),ephemeralPublicDer:eph.publicKey.export({format:'der',type:'spki'}).toString('base64'),salt:salt.toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:b.toString('base64')};
}
export function unseal(x,k){
 check(x.schema===1&&x.algorithm==='X25519-HKDF-SHA256-AES256GCM'&&x.keyId===k.keyId,'ENVELOPE_KEY_MISMATCH');
 const ep=crypto.createPublicKey({key:Buffer.from(x.ephemeralPublicDer,'base64'),format:'der',type:'spki'});
 const key=Buffer.from(crypto.hkdfSync('sha256',crypto.diffieHellman({privateKey:k.privateKey,publicKey:ep}),Buffer.from(x.salt,'base64'),Buffer.from(CONTEXT),32));
 const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(x.iv,'base64'));d.setAAD(Buffer.from(CONTEXT));d.setAuthTag(Buffer.from(x.tag,'base64'));
 return JSON.parse(Buffer.concat([d.update(Buffer.from(x.ciphertext,'base64')),d.final()]).toString());
}
export function checkRequest(r,now=Date.now()){
 check(r.action==='backup-private-recovery-v3'&&r.sha256===ARCHIVE_HASH&&r.size===ARCHIVE_SIZE,'UNAPPROVED_ARCHIVE');
 check(Number.isSafeInteger(r.expiresAt)&&r.expiresAt>now&&r.expiresAt<=now+900000,'SOURCE_URL_EXPIRED');
 checkSource(r.url);return r;
}
export function checkSource(url){const u=new URL(url);check(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(u.hostname==='dropbox.com'||u.hostname.endsWith('.dropbox.com')||u.hostname==='dropboxusercontent.com'||u.hostname.endsWith('.dropboxusercontent.com')),'SOURCE_HOST_REJECTED');return u;}
export async function main(){
 const k=keys(process.env.PINATA_JWT),dir='build/pinata-private-recovery';fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(dir+'/public-key.json',JSON.stringify({schema:1,keyId:k.keyId,publicDer:k.publicDer,context:CONTEXT},null,2));
 if(!process.argv.includes('--transfer')){console.log('TRANSFER_PUBLIC_KEY_READY_NO_UPLOAD');return;}
 const requestPath='release/pinata-recovery-request.sealed.json';
 check(fs.existsSync(requestPath),'SEALED_REQUEST_NOT_INSTALLED');
 const request=checkRequest(unseal(JSON.parse(fs.readFileSync(requestPath)),k));
 // The temporary URL is never committed in cleartext and never logged.
 let url=request.url,response;
 for(let n=0;n<5;n++){
  checkSource(url);response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');check(next,'EMPTY_REDIRECT');url=new URL(next,url).href;continue;}break;
 }
 check(response?.ok,'SOURCE_DOWNLOAD_FAILED');
 const chunks=[];let size=0;for await(const c of response.body){size+=c.length;check(size<=ARCHIVE_SIZE,'ARCHIVE_TOO_LARGE');chunks.push(c);}
 const archive=Buffer.concat(chunks);check(size===ARCHIVE_SIZE&&sha(archive)===ARCHIVE_HASH,'ARCHIVE_CHECKSUM_MISMATCH');
 const aesKey=crypto.randomBytes(32),partSize=40*1024*1024,parts=[];
 const receipt={schema:1,status:'UPLOADING',archiveSha256:ARCHIVE_HASH,archiveBytes:ARCHIVE_SIZE,encryption:'AES-256-GCM',key:aesKey.toString('base64'),parts};
 const save=()=>fs.writeFileSync(dir+'/receipt.sealed.json',JSON.stringify(seal(receipt,k.publicDer),null,2));
 save();
 try{
  for(let offset=0,index=0;offset<archive.length;offset+=partSize,index++){
   const data=archive.subarray(offset,offset+partSize),iv=crypto.randomBytes(12),aad=Buffer.from(`${CONTEXT}:${ARCHIVE_HASH}:${index}`);
   const cipher=crypto.createCipheriv('aes-256-gcm',aesKey,iv);cipher.setAAD(aad);
   const enc=Buffer.concat([cipher.update(data),cipher.final()]);
   const form=new FormData();form.append('file',new Blob([enc],{type:'application/octet-stream'}),`CoolBears_v3_recovery.part${String(index+1).padStart(3,'0')}.cbenc`);form.append('network','private');form.append('name',`CoolBears v3 encrypted private recovery ${index+1}`);
   // This is the same upload API already used by this repository, with private
   // rather than public network. Never fall back to public on an API error.
   const r=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+process.env.PINATA_JWT},body:form,redirect:'error',signal:AbortSignal.timeout(180000)});
   check(r.ok,`PINATA_UPLOAD_HTTP_${r.status}`);const j=await r.json(),f=j.data;
   check(f&&typeof f.id==='string'&&typeof f.cid==='string','PINATA_RECEIPT_INCOMPLETE');
   parts.push({index,offset,bytes:data.length,plaintextSha256:sha(data),ciphertextSha256:sha(enc),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),aad:aad.toString('base64'),fileId:f.id,cid:f.cid,network:f.network??null});save();
   check(f.network==='private','PRIVATE_NETWORK_NOT_CONFIRMED');
   if(f.size!==undefined)check(Number(f.size)===enc.length,'PINATA_SIZE_MISMATCH');
  }
  receipt.status='PRIVATE_UPLOAD_ACCEPTED';save();
  const summary={schema:1,status:receipt.status,archiveSha256:ARCHIVE_HASH,archiveBytes:ARCHIVE_SIZE,uploadedParts:parts.length,network:'private',clientSideEncrypted:true,plaintextOrDownloadUrlPublished:false,fullDownloadVerified:false,final10000ImagesPublished:false,mainnetReady:false,checkedAt:new Date().toISOString()};
  fs.writeFileSync(dir+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
 }catch(e){receipt.status='PARTIAL_OR_FAILED';save();console.error('PRIVATE_UPLOAD_STOPPED',String(e.message).replace(/https?:\/\/\S+/g,'[redacted]'));throw Error('PRIVATE_BACKUP_NOT_COMPLETED');}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(String(e.message).replace(/https?:\/\/\S+/g,'[redacted]'));process.exitCode=1;});
