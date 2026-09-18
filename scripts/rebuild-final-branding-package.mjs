// Offline unsigned preparation only. Input stays private; output public candidate
// contains only hashes, not final content URIs or the reveal preimage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as core from '@ton/core';
import {verifyPackage,PACKAGE_SHA256} from '../launch/package-tools.mjs';
const root=process.env.COOLBEARS_BRANDING_RELEASE;
assert.ok(root&&path.isAbsolute(root),'Explicit private release directory required');
const source=process.env.COOLBEARS_BRANDING_SOURCE_CANDIDATE;
if(source)assert.ok(path.isAbsolute(source),'Source candidate must be an explicit absolute path');
const bytes=fs.readFileSync(source||'launch/candidate.json'),p=JSON.parse(bytes);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(bytes),source?'763ad4e4c4e7c230652a5b44d18ef175d1abed4d989cef7b0d0116fb3e7a684f':PACKAGE_SHA256);
const v=verifyPackage(core,p),s=JSON.parse(fs.readFileSync('release/launch-state.json'));
assert.equal(s.phase,'hold');
for(const flag of ['mainnetVerified','creatorNftVerified','publicMintApproved','automaticRevealArmed'])assert.equal(s[flag],false);
const mb=fs.readFileSync(path.join(root,'manifest.PRIVATE.json')),m=JSON.parse(mb);
const proof=JSON.parse(fs.readFileSync(path.join(root,'branding-proof.json')));
assert.equal(sha(mb),proof.manifestSha256);
assert.equal(proof.unchangedPngFiles,10000);assert.equal(proof.unchangedMetadataFiles,10000);
assert.equal(proof.previousCarExactlyReproduced,true);
assert.equal(proof.sourceCarSha256,p.releaseCarSha256);assert.equal(proof.sourceManifestSha256,p.releaseManifestSha256);
assert.equal(m.brandingRevision,'final-collection-branding-1');
const col=JSON.parse(fs.readFileSync(path.join(root,'collection.json'))),a=JSON.parse(fs.readFileSync('release/prereveal-assets.json'));
assert.equal(col.image,'ipfs://'+a.logo.cid);assert.equal(col.cover_image,'ipfs://'+a.banner.cid);
const content=core.beginCell().storeRef(core.beginCell().storeUint(1,8).storeStringTail(m.collectionMetadataIpfs).endCell()).storeRef(core.beginCell().storeStringTail(m.metadataRootIpfs).endCell()).endCell();
const commitment=content.hash().toString('hex'),d=v.data;
assert.notEqual(commitment,p.finalContentCommitment);
const data=core.beginCell().storeAddress(d.owner).storeUint(0,64).storeRef(d.content).storeRef(d.item).storeRef(d.royalty).storeAddress(d.treasury).storeBit(true).storeBit(false).storeUint(BigInt('0x'+commitment),256).endCell();
const init={code:v.init.code,data},address=core.contractAddress(0,init),boc=core.beginCell().store(core.storeStateInit(init)).endCell().toBoc().toString('base64');
const bounce=address.toString({bounceable:true,testOnly:false}),nonBounce=address.toString({bounceable:false,testOnly:false});
const out={...p,collectionAddressRaw:address.toRawString(),collectionAddressMainnetBounceable:bounce,collectionAddressMainnetNonBounceable:nonBounce,stateInitBocBase64:boc,
 finalContentCommitment:commitment,releaseManifestSha256:proof.manifestSha256,releaseCarSha256:proof.carSha256,
 tonConnectDeployMessage:{...p.tonConnectDeployMessage,address:nonBounce,stateInit:boc},
 tonConnectCreatorClaimRequest:{...p.tonConnectCreatorClaimRequest,messages:[{...p.tonConnectCreatorClaimRequest.messages[0],address:bounce}]},
 finalBrandingRevision:m.brandingRevision};
const checked=verifyPackage(core,out);
for(const k of ['owner','treasury'])assert.ok(checked.data[k].equals(d[k]));
for(const k of ['content','item','royalty'])assert.ok(checked.data[k].equals(d[k]));
assert.ok(checked.init.code.equals(v.init.code));
const raw=JSON.stringify(out,null,2)+'\n';
const dir=path.join(root,'unsigned-packages');fs.mkdirSync(dir,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(dir,'mainnet.candidate.json'),raw);
fs.writeFileSync(path.join(dir,'reveal.PRIVATE.json'),JSON.stringify({schema:1,collectionAddressRaw:address.toRawString(),codeHash:p.collectionCodeHash,commitment,revealAt:p.revealAt,contentBoc:content.toBoc().toString('base64'),bundleCid:m.bundleCid,carSha256:proof.carSha256},null,2)+'\n');
const report={status:'FINAL_BRANDING_UNSIGNED_PACKAGE_PREPARED',sourcePackageSha256:sha(bytes),packageSha256:sha(raw),collectionAddressMainnetNonBounceable:nonBounce,collectionAddressRaw:address.toRawString(),manifestSha256:proof.manifestSha256,carSha256:proof.carSha256,finalContentCommitment:commitment,unchangedCode:true,unchangedItemMetadata:true,unchangedPrereveal:true,transactionsSent:0};
fs.writeFileSync(path.join(root,'package-proof.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
