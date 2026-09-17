// Authenticated read-back, not a comparison against Pinata's accounting size.
// Account secrets and signed links must never be logged or returned as evidence.
import crypto from 'node:crypto';
export const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
export const requireThat=(ok,code)=>{if(!ok)throw Error(code);};
export function verifyEncryptedPart(bytes,p,key){
 requireThat(bytes.length===p.bytes,'DOWNLOADED_LENGTH_MISMATCH');
 requireThat(digest(bytes)===p.ciphertextSha256,'CIPHERTEXT_HASH_MISMATCH');
 const d=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),Buffer.from(p.iv,'base64'));
 d.setAAD(Buffer.from(p.aad,'base64'));d.setAuthTag(Buffer.from(p.tag,'base64'));
 let clear;try{clear=Buffer.concat([d.update(bytes),d.final()]);}catch{throw Error('PART_AUTHENTICATION_FAILED');}
 requireThat(clear.length===p.bytes&&digest(clear)===p.plaintextSha256,'PLAINTEXT_HASH_MISMATCH');return clear;
}
export function validateGateway(value){
 const u=new URL(/^https:\/\//.test(value)?value:'https://'+value);
 requireThat(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.hostname.endsWith('.mypinata.cloud')&&/^[a-z0-9-]+\.mypinata\.cloud$/.test(u.hostname),'UNTRUSTED_GATEWAY');return u.origin;
}
export async function readBounded(response,limit){
 requireThat(response.ok,'DOWNLOAD_HTTP_'+response.status);
 const chunks=[];let n=0;for await(const b of response.body){n+=b.length;requireThat(n<=limit,'DOWNLOAD_EXCEEDS_EXPECTED_BYTES');chunks.push(b);}return Buffer.concat(chunks);
}
export function client(jwt,fetchFn=fetch){
 requireThat(typeof jwt==='string'&&jwt.length>=32,'PINATA_SECRET_MISSING');
 async function api(path,{method='GET',body}={}){
  requireThat(path.startsWith('/v3/'),'UNEXPECTED_API_PATH');
  let r;
  for(let i=0;i<3;i++){
   r=await fetchFn('https://api.pinata.cloud'+path,{method,headers:{Authorization:'Bearer '+jwt,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(![429,502,503,504].includes(r.status)||i===2)break;await new Promise(resolve=>setTimeout(resolve,1500*(i+1)));
  }
  requireThat(r.ok,'PINATA_API_HTTP_'+r.status);return r.json();
 }
 async function gateway(configured){
  if(configured)return validateGateway(configured);
  const j=await api('/v3/ipfs/gateways');
  const d=j.data,rows=Array.isArray(d)?d:Array.isArray(d?.rows)?d.rows:Array.isArray(d?.gateways)?d.gateways:null;
  requireThat(rows&&rows.length,'PRIVATE_GATEWAY_NOT_FOUND');
  // Only use the account's gateway domain returned by the authenticated API.
  function hostValues(x,depth=0){
   if(depth>4||!x)return [];
   if(typeof x==='string')return x.includes('.mypinata.cloud')?[x]:[];
   if(Array.isArray(x))return x.flatMap(y=>hostValues(y,depth+1));
   if(typeof x==='object')return Object.values(x).flatMap(y=>hostValues(y,depth+1));return [];
  }
  for(const row of rows)for(const name of hostValues(row)){try{return validateGateway(name);}catch{}}
  console.log('PINATA_GATEWAY_FIELDS',JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value])))));
  throw Error('PRIVATE_GATEWAY_DOMAIN_NOT_FOUND');
 }
 async function readPart(part,key,origin){
  requireThat(typeof part.fileId==='string'&&/^[A-Za-z0-9-]+$/.test(part.fileId),'BAD_PRIVATE_FILE_ID');
  requireThat(typeof part.cid==='string'&&/^(b[a-z2-7]+|Qm[1-9A-HJ-NP-Za-km-z]+)$/.test(part.cid),'BAD_PRIVATE_FILE_CID');
  const meta=await api('/v3/files/private/'+encodeURIComponent(part.fileId));
  requireThat(meta.data?.id===part.fileId&&meta.data.cid===part.cid,'PRIVATE_METADATA_MISMATCH');
  const base=validateGateway(origin),url=base+'/files/'+part.cid;
  const signed=await api('/v3/files/sign',{method:'POST',body:{url,expires:180,date:Math.floor(Date.now()/1000),method:'GET'}});
  const link=typeof signed.data==='string'?signed.data:signed.data?.url;
  requireThat(typeof link==='string','NO_SIGNED_DOWNLOAD');const u=new URL(link),wanted=new URL(url);
  requireThat(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_LINK_TARGET_MISMATCH');
  // No Authorization header leaves api.pinata.cloud/uploads.pinata.cloud.
  const r=await fetchFn(u.href,{redirect:'error',signal:AbortSignal.timeout(180000)});
  const bytes=await readBounded(r,part.bytes),clear=verifyEncryptedPart(bytes,part,key);
  return {clear,metadataSize:meta.data.size,downloadedBytes:bytes.length,ciphertextSha256:digest(bytes)};
 }
 return {api,gateway,readPart};
}
