// Builds an UNSIGNED package into build only. No wallet, network or release activation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as core from '@ton/core';
import {verifyPackage,PACKAGE_SHA256} from '../launch/package-tools.mjs';
const bytes=fs.readFileSync('launch/candidate.json'),p=JSON.parse(bytes);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(bytes),PACKAGE_SHA256);
const v=verifyPackage(core,p),a=JSON.parse(fs.readFileSync('release/prereveal-assets.json'));
const s=JSON.parse(fs.readFileSync('release/launch-state.json'));
assert.equal(s.phase,'hold');
for(const flag of ['mainnetVerified','creatorNftVerified','publicMintApproved','automaticRevealArmed'])assert.equal(s[flag],false);
const collectionMetadataIpfs='ipfs://'+a.collectionCid,preRevealMetadataRootIpfs='ipfs://'+a.itemsCid+'/';
const content=core.beginCell().storeRef(core.beginCell().storeUint(1,8).storeStringTail(collectionMetadataIpfs).endCell()).storeRef(core.beginCell().storeStringTail(preRevealMetadataRootIpfs).endCell()).endCell();
const d=v.data;
const data=core.beginCell().storeAddress(d.owner).storeUint(0,64).storeRef(content).storeRef(d.item).storeRef(d.royalty).storeAddress(d.treasury).storeBit(true).storeBit(false).storeUint(d.commitment,256).endCell();
const init={code:v.init.code,data},address=core.contractAddress(0,init);
const stateInitBocBase64=core.beginCell().store(core.storeStateInit(init)).endCell().toBoc().toString('base64');
const out={...p,collectionAddressRaw:address.toRawString(),collectionAddressMainnetBounceable:address.toString({bounceable:true,testOnly:false}),collectionAddressMainnetNonBounceable:address.toString({bounceable:false,testOnly:false}),collectionMetadataIpfs,preRevealMetadataRootIpfs,stateInitBocBase64,
  tonConnectDeployMessage:{...p.tonConnectDeployMessage,address:address.toString({bounceable:false,testOnly:false}),stateInit:stateInitBocBase64},
  tonConnectCreatorClaimRequest:{...p.tonConnectCreatorClaimRequest,messages:[{...p.tonConnectCreatorClaimRequest.messages[0],address:address.toString({bounceable:true,testOnly:false})}]},
  metadataRevision:a.metadataRevision
};
const checked=verifyPackage(core,out);
for(const field of ['owner','treasury'])assert.ok(checked.data[field].equals(d[field]));
for(const field of ['item','royalty'])assert.equal(checked.data[field].hash().toString('hex'),d[field].hash().toString('hex'));
assert.equal(checked.data.commitment,d.commitment);
assert.equal(checked.init.code.hash().toString('hex'),v.init.code.hash().toString('hex'));
const output=JSON.stringify(out,null,2)+'\n';
fs.mkdirSync('build/hidden-metadata',{recursive:true});
fs.writeFileSync('build/hidden-metadata/candidate.json',output);
console.log(JSON.stringify({sourcePackageSha256:sha(bytes),packageSha256:sha(output),collectionAddress:out.collectionAddressMainnetNonBounceable,unchangedCode:true,unchangedFinalCommitment:true,transactionsSent:0}));
