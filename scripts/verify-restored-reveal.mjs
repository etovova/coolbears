// Verify the private reveal preimage against the already tested public package.
// This script does not perform any network request or transaction.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import * as core from '@ton/core';import {verifyPackage,PACKAGE_SHA256,REVEAL_AT} from '../launch/package-tools.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
const raw=fs.readFileSync('launch/candidate.json'),p=JSON.parse(raw);
check(crypto.createHash('sha256').update(raw).digest('hex')===PACKAGE_SHA256,'Wrong public package');verifyPackage(core,p);
const dir=path.join(process.env.RUNNER_TEMP,'coolbears-verified-recovery');
const r=JSON.parse(fs.readFileSync(path.join(dir,'reveal.json'))),m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
check(r.collectionAddressRaw===p.collectionAddressRaw&&r.codeHash===p.collectionCodeHash&&r.commitment===p.finalContentCommitment&&r.revealAt===REVEAL_AT&&r.carSha256===p.releaseCarSha256,'Private reveal package mismatch');
const content=core.Cell.fromBase64(r.contentBoc);check(content.hash().toString('hex')===p.finalContentCommitment,'Commitment does not match reveal preimage');
const s=content.beginParse();check(s.remainingBits===0&&s.remainingRefs===2,'Incorrect content layout');
const c=s.loadRef().beginParse();check(c.loadUint(8)===1&&c.loadStringTail()===m.collectionMetadataIpfs,'Final collection URI mismatch');
check(s.loadRef().beginParse().loadStringTail()===m.metadataRootIpfs&&r.bundleCid===m.bundleCid,'Final item root mismatch');
const result={schema:1,status:'RESTORED_REVEAL_COMMITMENT_VERIFIED',packageSha256:PACKAGE_SHA256,collectionAddressRaw:p.collectionAddressRaw,finalContentCommitment:p.finalContentCommitment,privatePreimageNotPublished:true,networkRequests:0,transactionsSent:0,mainnetReady:false};
fs.writeFileSync('build/private-recovery-restore/reveal-binding.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
