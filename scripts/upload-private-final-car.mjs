// Upload the already hash-verified final CAR to Pinata PRIVATE storage, then stream it back and re-hash it.
// CID, signed URLs and account secrets are never printed or stored in public evidence.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {client,requireThat} from './pinata-backup-io.mjs';

const EXPECTED='3d6377484e3d27361c367be7b002a065d83426342df30f25e1d681b4d50f820c';
const NAME='CoolBears v3 FINAL CAR private verified';
const hashFile=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const runCurl=(args,{capture=true}={})=>new Promise((resolve,reject)=>{const p=spawn('curl',args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='',err='';if(capture)p.stdout.on('data',b=>{out+=b});p.stderr.on('data',b=>{err+=b});p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error('CURL_FAILED_'+c)));});

const carPath=fs.readFileSync('build/private-final-car/car-path.txt','utf8').trim();
requireThat(fs.existsSync(carPath),'CAR_NOT_FOUND');
requireThat((await hashFile(carPath))===EXPECTED,'PREUPLOAD_CAR_HASH_MISMATCH');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');
const api=client(jwt);const gateway=await api.gateway(process.env.PINATA_GATEWAY);

const upload=await runCurl(['--fail-with-body','--silent','--show-error','--request','POST','https://uploads.pinata.cloud/v3/files','--header','Authorization: Bearer '+jwt,'--form','network=private','--form','name='+NAME,'--form','file=@'+carPath+';type=application/vnd.ipld.car']);
let parsed;try{parsed=JSON.parse(upload)}catch{throw Error('UPLOAD_RESPONSE_NOT_JSON')}
const f=parsed?.data;requireThat(f&&typeof f.id==='string'&&typeof f.cid==='string','UPLOAD_RECEIPT_MISSING');
requireThat((f.network??'private')==='private','PRIVATE_NETWORK_NOT_CONFIRMED');
const meta=await api.api('/v3/files/private/'+encodeURIComponent(f.id));
requireThat(meta.data?.id===f.id&&meta.data?.cid===f.cid,'PRIVATE_METADATA_MISMATCH');
const base=new URL(gateway),url=base.origin+'/files/'+f.cid;
const signed=await api.api('/v3/files/sign',{method:'POST',body:{url,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
const link=typeof signed.data==='string'?signed.data:signed.data?.url;requireThat(typeof link==='string','NO_SIGNED_DOWNLOAD');
const u=new URL(link),wanted=new URL(url);requireThat(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_LINK_TARGET_MISMATCH');
const readback=process.env.RUNNER_TEMP+'/CoolBears_v3_final.readback.car';
await runCurl(['--fail','--silent','--show-error','--output',readback,u.href],{capture:false});
const st=fs.statSync(readback);requireThat(st.size===fs.statSync(carPath).size,'READBACK_SIZE_MISMATCH');
const readHash=await hashFile(readback);requireThat(readHash===EXPECTED,'READBACK_CAR_HASH_MISMATCH');
fs.rmSync(readback,{force:true});
const summary={schema:1,status:'PRIVATE_FINAL_CAR_PINATA_READBACK_VERIFIED',checkedAt:new Date().toISOString(),carSha256:EXPECTED,carBytes:fs.statSync(carPath).size,network:'private',privateMetadataMatched:true,downloadedBytesVerified:true,readbackSha256Verified:true,fileIdDigest:crypto.createHash('sha256').update(f.id).digest('hex'),cidDigest:crypto.createHash('sha256').update(f.cid).digest('hex'),walletOperations:false,salesChanged:false,publicIpfsPublication:false};
fs.mkdirSync('build/private-final-car',{recursive:true});fs.writeFileSync('build/private-final-car/storage-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
