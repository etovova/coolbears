// Upload exactly five approved PUBLIC prereveal CARs. No final assets or TON calls.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PACKAGE_SHA256} from '../release-guard.mjs';
import {validateHiddenMetadata} from './prereveal-policy.mjs';
import './test-prereveal-policy.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const a=JSON.parse(fs.readFileSync('release/prereveal-assets.json'));
const p=JSON.parse(fs.readFileSync('launch/candidate.json'));
const s=JSON.parse(fs.readFileSync('release/launch-state.json'));
assert.equal(sha(fs.readFileSync('launch/candidate.json')),PACKAGE_SHA256);
assert.equal(s.phase,'hold');
for(const flag of ['mainnetVerified','creatorNftVerified','publicMintApproved','automaticRevealArmed'])assert.equal(s[flag],false);
assert.equal(p.collectionMetadataIpfs,'ipfs://'+a.collectionCid);
assert.equal(p.preRevealMetadataRootIpfs,'ipfs://'+a.itemsCid+'/');
const media=JSON.parse(fs.readFileSync('build/hidden-metadata/media-proof.json'));
assert.equal(media.strictImageDecodeVerified,true);
assert.equal(media.gifSha256,a.gif.sha256);
const cars=JSON.parse(fs.readFileSync('build/hidden-metadata/cars.json'));
const expected=[a.logo.cid,a.banner.cid,a.collectionCid,a.templateCid,a.itemsCid];
assert.deepEqual(cars.map(r=>r.name),['logo','banner','collection','template','items']);
assert.deepEqual(cars.map(r=>r.cid),expected);
const jwt=process.env.PINATA_JWT;assert.ok(jwt,'Configured Pinata credential missing');
for(const row of cars){
  assert.equal(row.carPath,`build/hidden-metadata/${row.name}.car`);
  const b=fs.readFileSync(row.carPath);assert.equal(sha(b),row.carSha256);
  const form=new FormData();
  form.set('file',new Blob([b],{type:'application/vnd.ipld.car'}),`${row.name}.car`);
  form.set('network','public');form.set('car','true');form.set('name',`CoolBears hidden-metadata-1 ${row.name}`);
  const r=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:`Bearer ${jwt}`},body:form,redirect:'error',signal:AbortSignal.timeout(120000)});
  assert.ok(r.ok,`Pinata public upload failed: HTTP ${r.status}`);
  const j=await r.json();assert.equal(j.data?.cid??j.cid??j.IpfsHash,row.cid,'Pinata changed CAR root');
  console.log('PINNED_PUBLIC_PREREVEAL',row.name,row.cid);
}
async function read(cid){
  let error;
  for(let i=0;i<6;i++){
    try{const r=await fetch('https://gateway.pinata.cloud/ipfs/'+cid,{signal:AbortSignal.timeout(45000)});assert.ok(r.ok,'Public readback HTTP '+r.status);return Buffer.from(await r.arrayBuffer());}
    catch(e){error=e;if(i<5)await new Promise(resolve=>setTimeout(resolve,3000));}
  }
  throw error;
}
for(const name of ['logo','banner'])assert.deepEqual(await read(a[name].cid),fs.readFileSync(a[name].source));
for(const [name,cid] of [['collection',a.collectionCid],['prereveal',a.templateCid]])assert.deepEqual(await read(cid),fs.readFileSync(`metadata/${name}.json`));
const sample=[0,1,4979,9999];
for(const i of sample){const f=String(i).padStart(4,'0')+'.json';const b=await read(a.itemsCid+'/'+f);assert.deepEqual(b,fs.readFileSync('build/prereveal-metadata/'+f));validateHiddenMetadata(JSON.parse(b),i);}
assert.equal(sha(await read(a.gif.cid)),a.gif.sha256);
const report={status:'passed',checkedAt:new Date().toISOString(),packageSha256:PACKAGE_SHA256,appliesToCurrentCandidate:true,collectionMetadataIpfs:p.collectionMetadataIpfs,preRevealMetadataRootIpfs:p.preRevealMetadataRootIpfs,metadataCount:10000,allMetadataNoAttributes:true,publicReadbackVerified:true,publicItemSample:sample,...media,finalFilesPublished:false,transactionsSent:0};
fs.writeFileSync('build/hidden-metadata/publication-proof.json',JSON.stringify(report,null,2)+'\n');
console.log('PREREVEAL_PUBLICATION_PROOF='+JSON.stringify(report));
