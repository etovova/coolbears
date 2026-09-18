// Guarded keyless CoolBears reveal for corrected v3-glasses-correction-1.
// Broadcast mode is fail-closed: it requires the corrected package, rebuilt corrected
// manifest, fully armed HOLD state, Jan 1 2027 deadline, AND a successful public
// publication receipt proving exact public metadata+PNG bytes before sendBoc.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Address,beginCell,external,storeMessage} from '@ton/core';
import {verifyPackage,verifyLive,PACKAGE_SHA256,REVEAL_AT} from '../launch/package-tools.mjs';
import * as core from '@ton/core';

const REVISION='v3-glasses-correction-1';
const MANIFEST_SHA='4d6dd18bf5050a9244862997e4a51ae9ba2026e656279745e7d4fee05213ce96';
const CAR_SHA='287406498c91a1791880bef7919a58c61e55a7dfd884aeb57c22a8ab49115b84';
const REVEAL_OP=0x5245564c;
const EXPECTED_YEAR=2027;
const SAMPLE_COUNT=4;
const check=(v,m)=>{if(!v)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mode=process.argv.includes('--broadcast')?'broadcast':'prepare-only';

const raw=fs.readFileSync('launch/candidate.json');
const p=JSON.parse(raw);
check(sha(raw)===PACKAGE_SHA256,'CANDIDATE_SHA_MISMATCH');
verifyPackage(core,p);
check(p.collectionRevision===REVISION,'CANDIDATE_REVISION_MISMATCH');
check(p.releaseManifestSha256===MANIFEST_SHA,'CANDIDATE_MANIFEST_SHA_MISMATCH');
check(p.releaseCarSha256===CAR_SHA,'CANDIDATE_CAR_SHA_MISMATCH');
check(p.revealAt===REVEAL_AT&&REVEAL_AT===1798761600,'REVEAL_DEADLINE_MISMATCH');

const state=JSON.parse(fs.readFileSync('release/launch-state.json'));
const outDir='build/automatic-reveal';fs.mkdirSync(outDir,{recursive:true});

if(mode==='prepare-only'){
  const prepared={schema:2,status:'CORRECTED_AUTOMATIC_REVEAL_GUARDS_PREPARED',mode,collectionRevision:REVISION,packageSha256:PACKAGE_SHA256,manifestSha256:MANIFEST_SHA,carSha256:CAR_SHA,revealAt:REVEAL_AT,requiresPublicPublicationReceipt:true,requiresPublicSampleCount:SAMPLE_COUNT,broadcast:false,networkRequests:0};
  fs.writeFileSync(outDir+'/summary.json',JSON.stringify(prepared,null,2)+'\n');
  console.log(JSON.stringify(prepared));
  process.exit(0);
}

const now=Math.floor(Date.now()/1000),year=new Date().getUTCFullYear();
check(year===EXPECTED_YEAR,'AUTOMATIC_REVEAL_WRONG_YEAR');
check(now>=REVEAL_AT,'AUTOMATIC_REVEAL_TOO_EARLY');
check(state.phase==='hold','PRODUCTION_NOT_HELD');
check(state.automaticRevealArmed===true,'AUTOMATIC_REVEAL_NOT_ARMED');
check(state.privateStorageVerified===true,'PRIVATE_STORAGE_NOT_VERIFIED');
check(state.testnetVerified===true,'TESTNET_NOT_VERIFIED');
check(state.mainnetVerified===true,'MAINNET_NOT_VERIFIED');
check(state.creatorNftVerified===true,'CREATOR_NFT_NOT_VERIFIED');
check(state.publicMintApproved===false,'PUBLIC_MINT_MUST_REMAIN_DISABLED');
check(state.packageSha256===PACKAGE_SHA256,'ARMED_PACKAGE_SHA_MISMATCH');

// Derive the exact reveal preimage from the freshly rebuilt corrected manifest.
const manifestPath=path.join(process.env.RUNNER_TEMP,'coolbears-final-car-work','release','manifest.PRIVATE.json');
check(fs.existsSync(manifestPath),'CORRECTED_MANIFEST_NOT_REBUILT');
const manifestBytes=fs.readFileSync(manifestPath);
check(sha(manifestBytes)===MANIFEST_SHA,'CORRECTED_MANIFEST_SHA_MISMATCH');
const manifest=JSON.parse(manifestBytes);
check(manifest.revision===REVISION,'CORRECTED_MANIFEST_REVISION_MISMATCH');
check(manifest.images===10000&&manifest.metadata===10000,'CORRECTED_MANIFEST_COUNTS_MISMATCH');
check(typeof manifest.collectionMetadataIpfs==='string'&&manifest.collectionMetadataIpfs.startsWith('ipfs://'),'FINAL_COLLECTION_METADATA_MISSING');
check(typeof manifest.metadataRootIpfs==='string'&&manifest.metadataRootIpfs.startsWith('ipfs://'),'FINAL_METADATA_ROOT_MISSING');

const content=beginCell()
  .storeRef(beginCell().storeUint(1,8).storeStringTail(manifest.collectionMetadataIpfs).endCell())
  .storeRef(beginCell().storeStringTail(manifest.metadataRootIpfs).endCell())
  .endCell();
check(content.hash().toString('hex')===p.finalContentCommitment,'REVEAL_PREIMAGE_HASH_MISMATCH');

// Defense in depth: public publication must already have completed successfully.
const publicationPath=outDir+'/publication-summary.json';
check(fs.existsSync(publicationPath),'PUBLICATION_RECEIPT_MISSING');
const publication=JSON.parse(fs.readFileSync(publicationPath,'utf8'));
check(publication.schema===4,'PUBLICATION_RECEIPT_SCHEMA_MISMATCH');
check(publication.collectionRevision===REVISION,'PUBLICATION_REVISION_MISMATCH');
check(publication.packageSha256===PACKAGE_SHA256,'PUBLICATION_PACKAGE_MISMATCH');
check(publication.manifestSha256===MANIFEST_SHA,'PUBLICATION_MANIFEST_MISMATCH');
check(publication.carSha256===CAR_SHA,'PUBLICATION_CAR_MISMATCH');
check(publication.publicReady===true,'PUBLIC_CONTENT_NOT_READY');
check(publication.publicBundleRootReachable===true,'PUBLIC_ROOT_NOT_VERIFIED');
check(publication.sampleMetadataAndImagesVerified===SAMPLE_COUNT,'PUBLIC_SAMPLE_NOT_FULLY_VERIFIED');
check(publication.privateCarFullHashVerified===true || publication.status==='CORRECTED_FINAL_PUBLIC_CONTENT_ALREADY_VERIFIED','PRIVATE_CAR_GATE_NOT_VERIFIED');
check(publication.onChainRevealAllowed===true,'PUBLICATION_DID_NOT_AUTHORIZE_REVEAL');
check(publication.privateIdentifiersExposed===false&&publication.privateCidsExposed===false,'PRIVATE_IDENTIFIER_EVIDENCE_POLICY_VIOLATION');

const body=beginCell().storeUint(REVEAL_OP,32).storeRef(content).endCell();
const message=external({to:Address.parse(p.collectionAddressRaw),body});
const messageCell=beginCell().store(storeMessage(message)).endCell();
const boc=messageCell.toBoc();
const prepared={schema:2,status:'CORRECTED_AUTOMATIC_REVEAL_MESSAGE_VERIFIED',mode,collectionRevision:REVISION,packageSha256:PACKAGE_SHA256,manifestSha256:MANIFEST_SHA,carSha256:CAR_SHA,revealAt:REVEAL_AT,messageSha256:sha(boc),contentCommitment:p.finalContentCommitment,publicPublicationReceiptVerified:true};

const apiBase=(process.env.TONCENTER_API_BASE||'https://toncenter.com/api/v2').replace(/\/$/,'');
check(apiBase==='https://toncenter.com/api/v2','UNTRUSTED_TONCENTER_ENDPOINT');
const apiKey=process.env.TONCENTER_API_KEY||'';
const headers={'Content-Type':'application/json',...(apiKey?{'X-API-Key':apiKey}:{})};
async function rpc(pathname,options={}){
  const r=await fetch(apiBase+pathname,{...options,headers:{...headers,...(options.headers||{})},redirect:'error',signal:AbortSignal.timeout(30000)});
  check(r.ok,'TONCENTER_HTTP_'+r.status);
  const j=await r.json();
  check(j.ok!==false,'TONCENTER_RPC_ERROR');
  return j.result;
}
async function live(){
  const q=encodeURIComponent(p.collectionAddressMainnetBounceable);
  const info=await rpc('/getAddressInformation?address='+q,{method:'GET'});
  const d=verifyLive(core,p,info);
  return {info,data:d};
}

const before=await live();
if(before.data.revealed){
  check(before.data.content.hash().toString('hex')===p.finalContentCommitment,'ALREADY_REVEALED_WRONG_CONTENT');
  const result={...prepared,status:'CORRECTED_AUTOMATIC_REVEAL_ALREADY_COMPLETE',broadcast:false,verifiedLive:true};
  fs.writeFileSync(outDir+'/summary.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  process.exit(0);
}

await rpc('/sendBoc',{method:'POST',body:JSON.stringify({boc:boc.toString('base64')})});
let verified=false;
for(let i=0;i<36;i++){
  await new Promise(r=>setTimeout(r,5000));
  try{
    const after=await live();
    if(after.data.revealed&&after.data.content.hash().toString('hex')===p.finalContentCommitment){verified=true;break;}
  }catch{}
}
check(verified,'REVEAL_BROADCAST_NOT_CONFIRMED');
const result={...prepared,status:'CORRECTED_AUTOMATIC_REVEAL_BROADCAST_AND_LIVE_VERIFIED',broadcast:true,verifiedLive:true};
fs.writeFileSync(outDir+'/summary.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
