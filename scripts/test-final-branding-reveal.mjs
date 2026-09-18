// Uses the private final manifest only in a local TVM. Never contacts a network.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import * as core from '@ton/core';import {Blockchain,internal} from '@ton/sandbox';
import {verifyPackage,verifyItem,itemAddress,REVEAL_AT,EXPECTED_OWNER} from '../launch/package-tools.mjs';
const dir=process.env.COOLBEARS_BRANDING_RELEASE;assert.ok(dir&&path.isAbsolute(dir));
const bytes=fs.readFileSync(path.join(dir,'unsigned-packages/mainnet.candidate.json')),p=JSON.parse(bytes);
const mb=fs.readFileSync(path.join(dir,'manifest.PRIVATE.json')),m=JSON.parse(mb);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(mb),p.releaseManifestSha256);
const content=core.beginCell().storeRef(core.beginCell().storeUint(1,8).storeStringTail(m.collectionMetadataIpfs).endCell()).storeRef(core.beginCell().storeStringTail(m.metadataRootIpfs).endCell()).endCell();
assert.equal(content.hash().toString('hex'),p.finalContentCommitment);
const col=JSON.parse(fs.readFileSync(path.join(dir,'collection.json'))),a=JSON.parse(fs.readFileSync('release/prereveal-assets.json'));
assert.equal(col.image,'ipfs://'+a.logo.cid);assert.equal(col.cover_image,'ipfs://'+a.banner.cid);
let tests=1;const v=verifyPackage(core,p),bc=await Blockchain.create();bc.now=REVEAL_AT-1;
function successful(r){const t=r.transactions.find(x=>x.inMessage?.info.dest?.equals(v.address));assert.ok(t);assert.equal(t.description.computePhase.exitCode,0);assert.equal(t.description.aborted,false);if(t.description.actionPhase)assert.equal(t.description.actionPhase.success,true);tests++;}
successful(await bc.sendMessage(internal({from:v.data.owner,to:v.address,bounce:false,value:300000000n,stateInit:v.init,body:core.beginCell().endCell()})));
successful(await bc.sendMessage(internal({from:v.data.owner,to:v.address,value:7100000000n,body:core.Cell.fromBase64(p.tonConnectCreatorClaimRequest.messages[0].payload)})));
const nft=itemAddress(core,p,0);
async function info(address){const s=await bc.getContract(address);assert.equal(s.accountState.type,'active');return {state:'active',code:s.accountState.state.code.toBoc().toString('base64'),data:s.accountState.state.data.toBoc().toString('base64')};}
verifyItem(core,p,await info(nft),0,EXPECTED_OWNER);tests++;
const suffix=core.beginCell().storeStringTail('0000.json').endCell();
async function uri(){const s=(await bc.runGetMethod(v.address,'get_nft_content',[{type:'int',value:0n},{type:'cell',cell:suffix}])).stackReader.readCell().beginParse();assert.equal(s.loadUint(8),1);return s.loadStringTail();}
assert.equal(await uri(),p.preRevealMetadataRootIpfs+'0000.json');tests++;
const message=core.external({to:v.address,body:core.beginCell().storeUint(0x5245564c,32).storeRef(content).endCell()});
async function rejected(msg){let failed=false;try{await bc.sendMessage(msg);}catch{failed=true;}assert.equal(failed,true);tests++;}
await rejected(message);assert.equal(await uri(),p.preRevealMetadataRootIpfs+'0000.json');
bc.now=REVEAL_AT;
await rejected(core.external({to:v.address,body:core.beginCell().storeUint(0x5245564c,32).storeRef(v.data.content).endCell()}));
successful(await bc.sendMessage(message));
assert.equal(await uri(),m.metadataRootIpfs+'0000.json');tests++;
const s=(await bc.runGetMethod(v.address,'get_collection_data',[])).stackReader;
assert.equal(s.readBigNumber(),1n);const cs=s.readCell().beginParse();assert.equal(cs.loadUint(8),1);assert.equal(cs.loadStringTail(),m.collectionMetadataIpfs);assert.ok(s.readAddress().equals(v.data.owner));tests++;
verifyItem(core,p,await info(nft),0,EXPECTED_OWNER);tests++;
const state=(await bc.runGetMethod(v.address,'get_mint_state',[])).stackReader;
assert.equal(state.readBigNumber(),1n);assert.equal(state.readBigNumber(),10000n);assert.equal(state.readBigNumber(),7000000000n);assert.equal(state.readBigNumber(),1n);tests++;
await rejected(message);
const report={status:'ACTUAL_FINAL_BRANDING_REVEAL_VERIFIED_OFFLINE',packageSha256:sha(bytes),finalContentCommitment:p.finalContentCommitment,testsPassed:tests,earlyRevealRejected:true,wrongContentRejected:true,revealReplayRejected:true,exactFinalCollectionUriVerified:true,exactFinalItemUriVerified:true,approvedLogoAndBannerVerified:true,nftIndexOwnerAddressPreserved:true,mintRemainsPaused:true,realNetworkRequests:0,transactionsSent:0};
fs.writeFileSync(path.join(dir,'reveal-test-proof.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
