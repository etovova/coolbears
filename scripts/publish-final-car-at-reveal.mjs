// Jan 1 corrected reveal publication gate.
// Scheduled mode only:
// 1) require exact corrected candidate and armed HOLD state;
// 2) use a freshly rebuilt, hash-verified corrected manifest;
// 3) reconstruct the exact corrected CAR from all verified PRIVATE Pinata chunks;
// 4) verify reconstructed CAR byte count + SHA-256;
// 5) publish that CAR to PUBLIC Pinata with resumable TUS;
// 6) verify public root plus exact metadata+PNG sample bytes;
// Only a successful publication-summary may authorize automatic-reveal.mjs.
// Private Pinata identifiers/CIDs/signed URLs are never logged or written to evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {beginCell} from '@ton/core';
import {client,requireThat} from './pinata-backup-io.mjs';

const REVISION='v3-glasses-correction-1';
const PACKAGE_SHA='f4fb17938415afa7541e69463337565a0e3a0e7c73a1eb71d3b87582c8becd05';
const MANIFEST_SHA='4c7af198c464356fa25c1f9598d33fa3f08ed60e0bd5c95068c0972483369001';
const CAR_SHA='7fd7eae76d315db216e0dbfb08bec036b1d0d80c4aa8d84a7472110de0efa853';
const CAR_BYTES=12779698722;
const PART_BYTES=256*1024*1024;
const PARTS=48;
const OLD_PREFIX='CoolBears v3 glasses-correction-1 FINAL CAR 28740649 part';
const PREFIX='CoolBears approved-description-1 FINAL CAR '+CAR_SHA.slice(0,8)+' part';
const PUBLIC_NAME='CoolBears approved-description-1 FINAL reveal bundle';
const REVEAL_AT=1798761600;
const SAMPLE=[0,1,4979,9999];
const partName=i=>`${i===0||i===PARTS-1?PREFIX:OLD_PREFIX} ${String(i+1).padStart(3,'0')} of ${String(PARTS).padStart(3,'0')}`;
const expectedPartBytes=i=>Math.min(PART_BYTES,CAR_BYTES-i*PART_BYTES);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hashFile=p=>new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(p);s.on('data',b=>h.update(b));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});
const runCurl=(args,{capture=true}={})=>new Promise((resolve,reject)=>{const p=spawn('curl',args,{stdio:['ignore',capture?'pipe':'ignore','pipe']});let out='';if(capture)p.stdout.on('data',b=>{out+=b});p.stderr.on('data',()=>{});p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(Error('CURL_FAILED_'+c)));});
const enc=v=>Buffer.from(v,'utf8').toString('base64');
const mode=process.argv.includes('--publish')?'publish':'prepare-only';

const candidateBytes=fs.readFileSync('launch/candidate.json');
const candidate=JSON.parse(candidateBytes);
requireThat(sha(candidateBytes)===PACKAGE_SHA,'CANDIDATE_SHA_MISMATCH');
requireThat(candidate.collectionRevision===REVISION,'CANDIDATE_REVISION_MISMATCH');
requireThat(candidate.releaseManifestSha256===MANIFEST_SHA,'CANDIDATE_MANIFEST_SHA_MISMATCH');
requireThat(candidate.releaseCarSha256===CAR_SHA,'CANDIDATE_CAR_SHA_MISMATCH');
requireThat(candidate.revealAt===REVEAL_AT,'REVEAL_DATE_MISMATCH');
requireThat(PARTS===Math.ceil(CAR_BYTES/PART_BYTES)&&expectedPartBytes(PARTS-1)===163232290,'PRIVATE_PARTITION_POLICY_MISMATCH');

const outDir='build/automatic-reveal';fs.mkdirSync(outDir,{recursive:true});
if(mode==='prepare-only'){
  const result={schema:4,status:'CORRECTED_FINAL_PUBLICATION_GATE_PREPARED',mode,collectionRevision:REVISION,packageSha256:PACKAGE_SHA,manifestSha256:MANIFEST_SHA,carSha256:CAR_SHA,carBytes:CAR_BYTES,privatePartsRequired:PARTS,revealAt:REVEAL_AT,sampleRecordsRequired:SAMPLE.length,publicationOrder:['rebuild-and-hash-verify-corrected-manifest','reconstruct-private-car','verify-private-car-sha256','public-tus-upload','verify-public-bundle-root','verify-public-metadata-and-png','allow-onchain-reveal'],networkRequests:0,uploadsPerformed:false,privateIdentifiersExposed:false,privateCidsExposed:false};
  fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  process.exit(0);
}

const state=JSON.parse(fs.readFileSync('release/launch-state.json'));
const now=Math.floor(Date.now()/1000),year=new Date().getUTCFullYear();
requireThat(year===2027&&now>=REVEAL_AT,'PUBLICATION_TOO_EARLY');
requireThat(state.phase==='hold','PRODUCTION_NOT_HELD');
requireThat(state.automaticRevealArmed===true&&state.privateStorageVerified===true&&state.testnetVerified===true&&state.mainnetVerified===true&&state.creatorNftVerified===true,'PUBLICATION_NOT_FULLY_ARMED');
requireThat(state.publicMintApproved===false,'PUBLIC_MINT_MUST_REMAIN_DISABLED');
requireThat(state.packageSha256===PACKAGE_SHA,'ARMED_PACKAGE_MISMATCH');
const jwt=process.env.PINATA_JWT;requireThat(jwt&&jwt.length>=32,'PINATA_SECRET_MISSING');

const releaseDir=path.join(process.env.RUNNER_TEMP,'coolbears-final-car-work','release');
const manifestPath=path.join(releaseDir,'manifest.PRIVATE.json');
requireThat(fs.existsSync(manifestPath),'CORRECTED_MANIFEST_NOT_REBUILT');
const manifestBytes=fs.readFileSync(manifestPath);
requireThat(sha(manifestBytes)===MANIFEST_SHA,'CORRECTED_MANIFEST_SHA_MISMATCH');
const manifest=JSON.parse(manifestBytes);
requireThat(manifest.revision===REVISION&&manifest.images===10000&&manifest.metadata===10000&&Array.isArray(manifest.records)&&manifest.records.length===10000,'CORRECTED_MANIFEST_POLICY_MISMATCH');
requireThat(typeof manifest.metadataRootIpfs==='string'&&manifest.metadataRootIpfs.startsWith('ipfs://'),'FINAL_METADATA_ROOT_MISSING');
requireThat(typeof manifest.collectionMetadataIpfs==='string'&&manifest.collectionMetadataIpfs.startsWith('ipfs://'),'FINAL_COLLECTION_METADATA_MISSING');
requireThat(typeof manifest.bundleCid==='string'&&/^(b[a-z2-7]+|Qm[1-9A-HJ-NP-Za-km-z]+)$/.test(manifest.bundleCid),'FINAL_BUNDLE_CID_INVALID');
for(const id of SAMPLE){const r=manifest.records[id];requireThat(r?.id===id&&/^[a-f0-9]{64}$/.test(r.metadataSha256)&&/^[a-f0-9]{64}$/.test(r.pngSha256)&&typeof r.imageCid==='string','SAMPLE_MANIFEST_RECORD_INVALID');}
const finalContent=beginCell().storeRef(beginCell().storeUint(1,8).storeStringTail(manifest.collectionMetadataIpfs).endCell()).storeRef(beginCell().storeStringTail(manifest.metadataRootIpfs).endCell()).endCell();
requireThat(finalContent.hash().toString('hex')===candidate.finalContentCommitment,'CORRECTED_MANIFEST_COMMITMENT_MISMATCH');

function publicUrl(uri){
  requireThat(typeof uri==='string'&&uri.startsWith('ipfs://'),'BAD_IPFS_URI');
  const rest=uri.slice(7).replace(/^\/+/, '');
  requireThat(/^[A-Za-z0-9]+(?:\/.*)?$/.test(rest),'BAD_IPFS_PATH');
  return 'https://gateway.pinata.cloud/ipfs/'+rest;
}
async function fetchBounded(url,limit){
  const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(60000)});
  requireThat(r.ok,'PUBLIC_GATEWAY_HTTP_'+r.status);
  const chunks=[];let n=0;
  for await(const b of r.body){n+=b.length;requireThat(n<=limit,'PUBLIC_OBJECT_TOO_LARGE');chunks.push(b);}
  return Buffer.concat(chunks);
}
async function publicRootVisible(){
  try{
    const r=await fetch(publicUrl('ipfs://'+manifest.bundleCid),{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(30000)});
    return r.ok;
  }catch{return false;}
}
async function verifyPublicSample(){
  try{
    const collectionBytes=await fetchBounded(publicUrl(manifest.collectionMetadataIpfs),2_000_000);
    if(sha(collectionBytes)!=='9c967ae68e932532a18e66fd605d170d9dae75da98d9d65dfbc8f11be84668fd')return false;
    const collection=JSON.parse(collectionBytes.toString('utf8'));
    const approved=JSON.parse(fs.readFileSync('release/prereveal-assets.json','utf8'));
    if(collection.image!=='ipfs://'+approved.logo.cid||collection.cover_image!=='ipfs://'+approved.banner.cid)return false;
    for(const asset of [approved.logo,approved.banner]){
      if(sha(await fetchBounded(publicUrl('ipfs://'+asset.cid),5_000_000))!==asset.sha256)return false;
    }
    for(const id of SAMPLE){
      const rec=manifest.records[id];
      const murl=publicUrl(manifest.metadataRootIpfs)+(manifest.metadataRootIpfs.endsWith('/')?'':'/')+String(id).padStart(4,'0')+'.json';
      const mb=await fetchBounded(murl,2_000_000);
      if(sha(mb)!==rec.metadataSha256)return false;
      const m=JSON.parse(mb.toString('utf8'));
      if(m.image!=='ipfs://'+rec.imageCid)return false;
      const ib=await fetchBounded(publicUrl(m.image),25_000_000);
      if(sha(ib)!==rec.pngSha256)return false;
    }
    return true;
  }catch{return false;}
}
async function listAllPrivate(api){
  const all=[];let token=null,pages=0;
  do{
    const qs=new URLSearchParams({limit:'100'});
    if(token)qs.set('pageToken',token);
    const j=await api.api('/v3/files/private?'+qs.toString());
    requireThat(Array.isArray(j?.data?.files),'PRIVATE_LIST_SHAPE_MISMATCH');
    all.push(...j.data.files);
    token=j.data.next_page_token||null;
    pages++;
    requireThat(pages<=100,'PRIVATE_LIST_TOO_MANY_PAGES');
  }while(token);
  return {rows:all,pages};
}
async function signedDownload(api,gateway,row,target){
  requireThat(typeof row.id==='string'&&typeof row.cid==='string','PRIVATE_PART_IDENTIFIER_MISSING');
  const meta=await api.api('/v3/files/private/'+encodeURIComponent(row.id));
  requireThat(meta.data?.id===row.id&&meta.data?.cid===row.cid,'PRIVATE_PART_METADATA_MISMATCH');
  const url=new URL(gateway).origin+'/files/'+row.cid;
  const signed=await api.api('/v3/files/sign',{method:'POST',body:{url,expires:900,date:Math.floor(Date.now()/1000),method:'GET'}});
  const link=typeof signed.data==='string'?signed.data:signed.data?.url;
  requireThat(typeof link==='string','NO_SIGNED_PART_DOWNLOAD');
  const u=new URL(link),wanted=new URL(url);
  requireThat(u.origin===wanted.origin&&u.pathname===wanted.pathname&&!u.username&&!u.password,'SIGNED_PART_TARGET_MISMATCH');
  await runCurl(['--fail','--silent','--show-error','--location','--retry','8','--retry-all-errors','--retry-delay','5','--output',target,u.href],{capture:false});
}
async function writeSuccess(status,uploadedNow,pages){
  const result={schema:4,status,collectionRevision:REVISION,packageSha256:PACKAGE_SHA,manifestSha256:MANIFEST_SHA,carSha256:CAR_SHA,carBytes:CAR_BYTES,privatePartsReconstructed:pages>0?PARTS:0,privateListPagesScanned:pages,privateCarFullHashVerified:pages>0,publicTusUploadVerified:uploadedNow,publicBundleRootReachable:true,finalCollectionMetadataAndBrandingVerified:true,sampleMetadataAndImagesVerified:SAMPLE.length,publicReady:true,uploadedNow,onChainRevealAllowed:true,privateIdentifiersExposed:false,privateCidsExposed:false};
  fs.writeFileSync(outDir+'/publication-summary.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}

// Idempotent retry: if exact committed public content is already byte-verified, do not upload again.
if(await publicRootVisible()&&await verifyPublicSample()){
  await writeSuccess('CORRECTED_FINAL_PUBLIC_CONTENT_ALREADY_VERIFIED',false,0);
  process.exit(0);
}

const api=client(jwt);
const listing=await listAllPrivate(api);
const rows=listing.rows;
const gateway=await api.gateway(process.env.PINATA_GATEWAY);
const car=path.join(process.env.RUNNER_TEMP,'CoolBears_v3_glasses_correction_1_FINAL_for_public_reveal.car');
const partTmp=path.join(process.env.RUNNER_TEMP,'CoolBears_v3_glasses_correction_1_FINAL_for_public_reveal.part');
fs.rmSync(car,{force:true});fs.rmSync(partTmp,{force:true});
const totalHash=crypto.createHash('sha256');let total=0;
try{
  for(let i=0;i<PARTS;i++){
    const name=partName(i),matches=rows.filter(x=>x?.name===name);
    requireThat(matches.length===1,'PRIVATE_FINAL_CAR_PART_NOT_UNIQUE');
    const row=matches[0];
    await signedDownload(api,gateway,row,partTmp);
    const actual=fs.statSync(partTmp).size;
    requireThat(actual===expectedPartBytes(i),'PRIVATE_PART_READBACK_SIZE_MISMATCH');
    await new Promise((resolve,reject)=>{
      const r=fs.createReadStream(partTmp),w=fs.createWriteStream(car,{flags:i===0?'w':'a',mode:0o600});
      r.on('data',b=>totalHash.update(b));r.on('error',reject);w.on('error',reject);w.on('finish',resolve);r.pipe(w);
    });
    total+=actual;
    fs.rmSync(partTmp,{force:true});
    console.log(`REVEAL_PRIVATE_CAR_PART_RECONSTRUCTED ${i+1}/${PARTS}`);
  }
  requireThat(total===CAR_BYTES&&fs.statSync(car).size===CAR_BYTES,'PRIVATE_CAR_RECONSTRUCTED_SIZE_MISMATCH');
  requireThat(totalHash.digest('hex')===CAR_SHA,'PRIVATE_CAR_RECONSTRUCTED_STREAM_HASH_MISMATCH');
  requireThat((await hashFile(car))===CAR_SHA,'PRIVATE_CAR_RECONSTRUCTED_FILE_HASH_MISMATCH');

  if(await publicRootVisible()){
    let ready=false;
    for(let i=0;i<60;i++){
      if(await verifyPublicSample()){ready=true;break;}
      await new Promise(r=>setTimeout(r,10000));
    }
    requireThat(ready,'EXISTING_PUBLIC_ROOT_WITHOUT_VERIFIED_OBJECTS');
    await writeSuccess('CORRECTED_FINAL_PUBLIC_CONTENT_PROPAGATION_VERIFIED',false,listing.pages);
    process.exit(0);
  }

  const meta=`filename ${enc('CoolBears_v3_glasses_correction_1_FINAL_reveal.car')},network ${enc('public')},name ${enc(PUBLIC_NAME)},car ${enc('true')}`;
  const create=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Length':String(CAR_BYTES),'Upload-Metadata':meta},redirect:'manual',signal:AbortSignal.timeout(30000)});
  requireThat(create.status===201,'TUS_PUBLIC_CAR_CREATE_HTTP_'+create.status);
  const loc=create.headers.get('location');requireThat(loc,'TUS_PUBLIC_CAR_LOCATION_MISSING');
  const tus=new URL(loc,'https://uploads.pinata.cloud/v3/files');
  requireThat(tus.protocol==='https:'&&tus.hostname==='uploads.pinata.cloud'&&!tus.username&&!tus.password,'TUS_PUBLIC_CAR_LOCATION_UNTRUSTED');
  let offset=0,part=0;
  while(offset<CAR_BYTES){
    const target=Math.min(offset+PART_BYTES,CAR_BYTES),length=target-offset;let done=false;
    for(let attempt=0;attempt<5&&!done;attempt++){
      try{
        const body=fs.createReadStream(car,{start:offset,end:target-1});
        const patch=await fetch(tus.href,{method:'PATCH',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream','Content-Length':String(length)},body,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(900000)});
        requireThat(patch.status===204,'TUS_PUBLIC_CAR_PATCH_HTTP_'+patch.status);
        requireThat(Number(patch.headers.get('upload-offset'))===target,'TUS_PUBLIC_CAR_OFFSET_MISMATCH');
        done=true;
      }catch(e){
        const head=await fetch(tus.href,{method:'HEAD',headers:{Authorization:'Bearer '+jwt,'Tus-Resumable':'1.0.0'},redirect:'manual',signal:AbortSignal.timeout(30000)});
        requireThat(head.ok||head.status===204,'TUS_PUBLIC_CAR_HEAD_HTTP_'+head.status);
        const remote=Number(head.headers.get('upload-offset'));
        if(remote===target){done=true;break;}
        requireThat(remote===offset,'TUS_PUBLIC_CAR_REMOTE_OFFSET_UNEXPECTED');
        if(attempt===4)throw e;
        await new Promise(r=>setTimeout(r,3000*(attempt+1)));
      }
    }
    requireThat(done,'TUS_PUBLIC_CAR_PART_NOT_CONFIRMED');
    offset=target;part++;
    console.log(`PUBLIC_FINAL_CAR_TUS_PART_CONFIRMED ${part}/${PARTS}`);
  }
  requireThat(offset===CAR_BYTES,'TUS_PUBLIC_CAR_FINAL_OFFSET_MISMATCH');

  let rootReady=false,objectsReady=false;
  for(let i=0;i<90;i++){
    rootReady=await publicRootVisible();
    if(rootReady&&await verifyPublicSample()){objectsReady=true;break;}
    await new Promise(r=>setTimeout(r,10000));
  }
  requireThat(rootReady,'PUBLIC_FINAL_BUNDLE_ROOT_NOT_GATEWAY_VERIFIED');
  requireThat(objectsReady,'PUBLIC_FINAL_CONTENT_NOT_GATEWAY_VERIFIED');
  await writeSuccess('CORRECTED_FINAL_PUBLIC_CAR_AND_OBJECTS_GATEWAY_VERIFIED',true,listing.pages);
} finally {
  fs.rmSync(partTmp,{force:true});
  fs.rmSync(car,{force:true});
}
