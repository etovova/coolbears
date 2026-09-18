// Publish only the approved public collection description; never final NFT data.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const root='release/description-correction/';
const r=JSON.parse(fs.readFileSync(root+'publication-request.json'));
const proof=JSON.parse(fs.readFileSync(root+'preparation.json'));
const b=fs.readFileSync(root+'unsigned-candidate.json'),p=JSON.parse(b);
assert.equal(r.authorized,true);assert.equal(sha(b),r.packageSha256);assert.equal(r.packageSha256,proof.packageSha256);
const s=JSON.parse(fs.readFileSync('release/launch-state.json'));
assert.equal(s.phase,'hold');assert.equal(s.publicMintApproved,false);assert.equal(s.automaticRevealArmed,false);
const meta=fs.readFileSync('metadata/collection.json');assert.equal(sha(meta),proof.collectionJsonSha256);
const desc=JSON.parse(meta).description;
assert.equal(desc,'10,000 unique CoolBears on TON. Everyone gets a bear. Not everyone gets a legend.\n\nNo real value. No financial returns. No celebrity backing. Don’t buy expecting profit. CoolBears is just for fun.\n\nMint will be available at https://coolbears-nfts.com');
fs.mkdirSync('build/description-correction',{recursive:true});
const car='build/description-correction/collection.car';
const cid=execFileSync('node_modules/.bin/ipfs-car',['pack','--no-wrap','metadata/collection.json','--output',car],{encoding:'utf8'}).trim();
assert.equal('ipfs://'+cid,p.collectionMetadataIpfs);
assert.equal(proof.collectionMetadataIpfs,p.collectionMetadataIpfs);
assert.ok(process.env.PINATA_JWT);
const form=new FormData();form.set('file',new Blob([fs.readFileSync(car)],{type:'application/vnd.ipld.car'}),'collection.car');form.set('network','public');form.set('car','true');form.set('name','CoolBears approved-description-1 collection');
const response=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+process.env.PINATA_JWT},body:form,redirect:'error',signal:AbortSignal.timeout(120000)});
assert.ok(response.ok,'PUBLIC_METADATA_UPLOAD_HTTP_'+response.status);const j=await response.json();assert.equal(j.data?.cid??j.cid??j.IpfsHash,cid);
let verified=false;
for(let i=0;i<6;i++){
 try{const got=await fetch('https://gateway.pinata.cloud/ipfs/'+cid,{signal:AbortSignal.timeout(45000)});assert.ok(got.ok);assert.deepEqual(Buffer.from(await got.arrayBuffer()),meta);verified=true;break;}
 catch(e){if(i===5)throw e;await new Promise(resolve=>setTimeout(resolve,3000));}
}
assert.ok(verified);
const report={status:'APPROVED_DESCRIPTION_PUBLIC_READBACK_VERIFIED',checkedAt:new Date().toISOString(),packageSha256:r.packageSha256,collectionMetadataIpfs:p.collectionMetadataIpfs,collectionJsonSha256:sha(meta),exactApprovedDescription:true,approvedLogoAndBannerUnchanged:true,finalNftFilesPublished:false,transactionsSent:0};
fs.writeFileSync('build/description-correction/publication-proof.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
