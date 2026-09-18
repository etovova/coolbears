// Public prereveal material only; deliberately never reads private/final assets.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
await import('./generate-prereveal-metadata.mjs');
await import('./test-prereveal-policy.mjs');
const a=JSON.parse(fs.readFileSync('release/prereveal-assets.json'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(JSON.parse(fs.readFileSync('node_modules/ipfs-car/package.json')).version,a.ipfsCarVersion);
const collection=JSON.parse(fs.readFileSync('metadata/collection.json'));
assert.equal(collection.image,'ipfs://'+a.logo.cid);assert.equal(collection.cover_image,'ipfs://'+a.banner.cid);
assert.notEqual(collection.image,collection.cover_image);
fs.mkdirSync('build/hidden-metadata',{recursive:true});
const inputs=[['logo',a.logo.source,a.logo.cid],['banner',a.banner.source,a.banner.cid],['collection','metadata/collection.json',a.collectionCid],['template','metadata/prereveal.json',a.templateCid],['items','build/prereveal-metadata',a.itemsCid]];
const records=[];
for(const [name,source,cid] of inputs){
  if(['logo','banner'].includes(name))assert.equal(sha(fs.readFileSync(source)),a[name].sha256,'Approved original bytes changed');
  const carPath=`build/hidden-metadata/${name}.car`;
  const root=execFileSync('node_modules/.bin/ipfs-car',['pack','--no-wrap',source,'--output',carPath],{encoding:'utf8'}).trim();
  assert.equal(root,cid,'Deterministic CAR root changed: '+name);
  records.push({name,cid,carPath,carSha256:sha(fs.readFileSync(carPath))});
}
fs.writeFileSync('build/hidden-metadata/cars.json',JSON.stringify(records,null,2)+'\n');
console.log(JSON.stringify({status:'PUBLIC_PREREVEAL_CARS_BUILT',metadataCount:10000,attributes:0,records,networkRequests:0,transactionsSent:0}));
