// Guarded keyless CoolBears reveal. The contract itself enforces the same deadline,
// exact final-content commitment and one-time reveal semantics.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Address,Cell,beginCell,external,storeMessage} from '@ton/core';
import {verifyPackage,verifyLive,PACKAGE_SHA256,REVEAL_AT} from '../launch/package-tools.mjs';
import * as core from '@ton/core';

const REVEAL_OP=0x5245564c;
const EXPECTED_YEAR=2027;
const check=(v,m)=>{if(!v)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const mode=process.argv.includes('--broadcast')?'broadcast':'prepare-only';
const raw=fs.readFileSync('launch/candidate.json');
const p=JSON.parse(raw);
check(sha(raw)===PACKAGE_SHA256,'CANDIDATE_SHA_MISMATCH');
verifyPackage(core,p);
check(p.revealAt===REVEAL_AT&&REVEAL_AT===1798761600,'REVEAL_DEADLINE_MISMATCH');

const state=JSON.parse(fs.readFileSync('release/launch-state.json'));
const recoveryDir=path.join(process.env.RUNNER_TEMP,'coolbears-verified-recovery');
const reveal=JSON.parse(fs.readFileSync(path.join(recoveryDir,'reveal.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(recoveryDir,'manifest.json')));
check(reveal.collectionAddressRaw===p.collectionAddressRaw,'REVEAL_ADDRESS_MISMATCH');
check(reveal.codeHash===p.collectionCodeHash,'REVEAL_CODE_MISMATCH');
check(reveal.commitment===p.finalContentCommitment,'REVEAL_COMMITMENT_MISMATCH');
check(reveal.revealAt===REVEAL_AT,'PRIVATE_REVEAL_DATE_MISMATCH');
check(reveal.carSha256===p.releaseCarSha256,'PRIVATE_REVEAL_CAR_MISMATCH');
const content=Cell.fromBase64(reveal.contentBoc);
check(content.hash().toString('hex')===p.finalContentCommitment,'REVEAL_PREIMAGE_HASH_MISMATCH');
const cs=content.beginParse();
check(cs.remainingBits===0&&cs.remainingRefs===2,'REVEAL_CONTENT_LAYOUT_MISMATCH');
const collection=cs.loadRef().beginParse();
check(collection.loadUint(8)===1&&collection.loadStringTail()===manifest.collectionMetadataIpfs,'REVEAL_COLLECTION_URI_MISMATCH');
check(cs.loadRef().beginParse().loadStringTail()===manifest.metadataRootIpfs,'REVEAL_ROOT_URI_MISMATCH');
check(reveal.bundleCid===manifest.bundleCid,'REVEAL_BUNDLE_MISMATCH');

const body=beginCell().storeUint(REVEAL_OP,32).storeRef(content).endCell();
const message=external({to:Address.parse(p.collectionAddressRaw),body});
const messageCell=beginCell().store(storeMessage(message)).endCell();
const boc=messageCell.toBoc();
const prepared={schema:1,status:'AUTOMATIC_REVEAL_MESSAGE_VERIFIED',mode,packageSha256:PACKAGE_SHA256,revealAt:REVEAL_AT,messageSha256:sha(boc),contentCommitment:p.finalContentCommitment,privatePreimagePublished:false};

if(mode==='prepare-only'){
  fs.mkdirSync('build/automatic-reveal',{recursive:true});
  fs.writeFileSync('build/automatic-reveal/summary.json',JSON.stringify({...prepared,broadcast:false},null,2)+'\n');
  console.log(JSON.stringify({...prepared,broadcast:false}));
  process.exit(0);
}

const now=Math.floor(Date.now()/1000), year=new Date().getUTCFullYear();
check(year===EXPECTED_YEAR,'AUTOMATIC_REVEAL_WRONG_YEAR');
check(now>=REVEAL_AT,'AUTOMATIC_REVEAL_TOO_EARLY');
check(state.automaticRevealArmed===true,'AUTOMATIC_REVEAL_NOT_ARMED');
check(state.privateStorageVerified===true,'PRIVATE_STORAGE_NOT_VERIFIED');
check(state.mainnetVerified===true,'MAINNET_NOT_VERIFIED');
check(state.creatorNftVerified===true,'CREATOR_NFT_NOT_VERIFIED');
check(state.packageSha256===PACKAGE_SHA256,'ARMED_PACKAGE_SHA_MISMATCH');

const apiBase=(process.env.TONCENTER_API_BASE||'https://toncenter.com/api/v2').replace(/\/$/,'');
check(apiBase==='https://toncenter.com/api/v2','UNTRUSTED_TONCENTER_ENDPOINT');
const apiKey=process.env.TONCENTER_API_KEY||'';
const headers={'Content-Type':'application/json',...(apiKey?{'X-API-Key':apiKey}:{})};
async function rpc(pathname,options={}){
  const r=await fetch(apiBase+pathname,{...options,headers:{...headers,...(options.headers||{})},redirect:'error',signal:AbortSignal.timeout(30000)});
  check(r.ok,'TONCENTER_HTTP_'+r.status);
  const j=await r.json();check(j.ok!==false,'TONCENTER_RPC_ERROR');return j.result;
}
async function live(){
  const q=encodeURIComponent(p.collectionAddressMainnetBounceable);
  const info=await rpc('/getAddressInformation?address='+q,{method:'GET'});
  const d=verifyLive(core,p,info);
  return {info,data:d};
}
let before=await live();
if(before.data.revealed){
  check(before.data.content.hash().toString('hex')===p.finalContentCommitment,'ALREADY_REVEALED_WRONG_CONTENT');
  console.log(JSON.stringify({...prepared,status:'AUTOMATIC_REVEAL_ALREADY_COMPLETE',broadcast:false,verifiedLive:true}));
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
fs.mkdirSync('build/automatic-reveal',{recursive:true});
const result={...prepared,status:'AUTOMATIC_REVEAL_BROADCAST_AND_LIVE_VERIFIED',broadcast:true,verifiedLive:true};
fs.writeFileSync('build/automatic-reveal/summary.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
