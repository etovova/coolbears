import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {
  validateLaunch,canOperate,revealDue,CANDIDATE_HASH,PACKAGE_SHA256,REVISION,
  MANIFEST_SHA256,CAR_SHA256,OWNER_RAW,REVEAL_AT
} from '../release-guard.mjs';

const p=JSON.parse(fs.readFileSync('launch/candidate.json','utf8'));
const base=JSON.parse(fs.readFileSync('release/launch-state.json','utf8'));
const ctx=vm.createContext({window:{},document:{addEventListener(){}}});
vm.runInContext(fs.readFileSync('config.js','utf8'),ctx);
const cfg={...ctx.window.COOLBEARS_CONFIG,demoMode:true};
let passed=0;
const test=(name,fn)=>{fn();passed++;console.log('PASS',name);};
const clone=structuredClone;

assert.equal(p.collectionRevision,REVISION);
assert.equal(p.collectionCodeHash,CANDIDATE_HASH);
assert.equal(p.releaseManifestSha256,MANIFEST_SHA256);
assert.equal(p.releaseCarSha256,CAR_SHA256);
assert.equal(base.packageSha256,PACKAGE_SHA256);

const hold={...clone(base),phase:'hold',mainnetVerified:false,creatorNftVerified:false,publicMintApproved:false,automaticRevealArmed:false};
delete hold.evidence.correctedMainnetDeployment;
delete hold.evidence.correctedMainnetCreatorNft0000;
const prepared={...clone(hold),phase:'prepared'};
const mainnetEvidence={
  status:'verified-live-mainnet',checkedAt:'2026-09-18T06:00:00Z',
  packageSha256:PACKAGE_SHA256,collectionRevision:REVISION,
  collectionAddressRaw:p.collectionAddressRaw,codeHash:CANDIDATE_HASH,
  accountActive:true,initialPausedVerified:true,nextItemIndex:0,appliesToCurrentCandidate:true
};
const creatorEvidence={
  status:'verified-live-mainnet',checkedAt:'2026-09-18T06:05:00Z',
  packageSha256:PACKAGE_SHA256,collectionRevision:REVISION,
  collectionAddressRaw:p.collectionAddressRaw,nftIndex:0,ownerAddressRaw:OWNER_RAW,
  ownerVerified:true,metadataUriVerified:true,appliesToCurrentCandidate:true
};
const approved={...clone(prepared),phase:'approved',mainnetVerified:true,creatorNftVerified:true,publicMintApproved:true,evidence:{...clone(prepared.evidence),correctedMainnetDeployment:mainnetEvidence,correctedMainnetCreatorNft0000:creatorEvidence}};
const live={...clone(approved),phase:'live'};
const active0={status:'active',minted:0,paused:true,creatorVerified:false};
const active1={status:'active',minted:1,paused:true,creatorVerified:true};

test('Corrected hold is read-only',()=>assert.deepEqual(validateLaunch(cfg,p,hold,PACKAGE_SHA256),{phase:'hold',setup:false,sales:false,automaticReveal:false}));
test('Prepared enables setup only',()=>assert.deepEqual(validateLaunch(cfg,p,prepared,PACKAGE_SHA256),{phase:'prepared',setup:true,sales:false,automaticReveal:false}));
test('Prepared deploy only while uninitialized',()=>{
  const g=validateLaunch(cfg,p,prepared,PACKAGE_SHA256);
  assert.equal(canOperate('deploy',g,{status:'uninitialized'},true),true);
  assert.equal(canOperate('deploy',g,active0,true),false);
});
test('Prepared creator claim allowed while paused at zero',()=>assert.equal(canOperate('claim',validateLaunch(cfg,p,prepared,PACKAGE_SHA256),active0,true),true));
test('Prepared cannot unpause',()=>assert.equal(canOperate('unpause',validateLaunch(cfg,p,prepared,PACKAGE_SHA256),active1,true),false));
test('Approved owner can unpause only after explicit approval',()=>assert.equal(canOperate('unpause',validateLaunch(cfg,p,approved,PACKAGE_SHA256),active1,true),true));
test('Approved phase does not itself make site live',()=>assert.equal(validateLaunch(cfg,p,approved,PACKAGE_SHA256).sales,false));
test('Live requires demoMode false',()=>assert.equal(validateLaunch({...cfg,demoMode:false},p,live,PACKAGE_SHA256).sales,true));
test('Wrong wallet cannot operate',()=>assert.equal(canOperate('claim',validateLaunch(cfg,p,prepared,PACKAGE_SHA256),active0,false),false));

for(const key of ['privateStorageVerified','testnetVerified'])test('Missing prerequisite '+key,()=>assert.throws(()=>validateLaunch(cfg,p,{...clone(prepared),[key]:false},PACKAGE_SHA256)));
test('Wrong package checksum rejected',()=>assert.throws(()=>validateLaunch(cfg,p,prepared,'0'.repeat(64))));
test('Wrong revision rejected',()=>assert.throws(()=>validateLaunch(cfg,{...p,collectionRevision:'v3'},prepared,PACKAGE_SHA256)));
test('Wrong CAR rejected',()=>assert.throws(()=>validateLaunch(cfg,{...p,releaseCarSha256:'0'.repeat(64)},prepared,PACKAGE_SHA256)));
test('Wrong manifest rejected',()=>assert.throws(()=>validateLaunch(cfg,{...p,releaseManifestSha256:'0'.repeat(64)},prepared,PACKAGE_SHA256)));
test('Private storage readback must be complete',()=>{
  const s=clone(prepared);s.evidence.privateStorage.partsVerified=47;
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('TESTNET audit operation order must match',()=>{
  const s=clone(prepared);s.evidence.correctedTestnetTransactionAudit.operations=['deploy','open','claim','mint'];
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('TESTNET #0001 ownership required',()=>{
  const s=clone(prepared);s.evidence.correctedTestnetNft0001.nft1OwnerVerified=false;
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('Prereveal animated GIF proof required',()=>{
  const s=clone(prepared);s.evidence.correctedPrerevealMedia.animatedGifVerified=false;
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('Approved requires mainnet proof',()=>{
  const s=clone(approved);delete s.evidence.correctedMainnetDeployment;
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('Approved requires creator proof',()=>{
  const s=clone(approved);delete s.evidence.correctedMainnetCreatorNft0000;
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('Approved requires creator owner match',()=>{
  const s=clone(approved);s.evidence.correctedMainnetCreatorNft0000.ownerAddressRaw='0:wrong';
  assert.throws(()=>validateLaunch(cfg,p,s,PACKAGE_SHA256));
});
test('Approved requires public mint approval',()=>assert.throws(()=>validateLaunch(cfg,p,{...clone(approved),publicMintApproved:false},PACKAGE_SHA256)));
test('Live with demoMode true rejected',()=>assert.throws(()=>validateLaunch(cfg,p,live,PACKAGE_SHA256)));
test('Unknown phase rejected',()=>assert.throws(()=>validateLaunch(cfg,p,{...clone(prepared),phase:'go'},PACKAGE_SHA256)));
test('Reveal due only when armed/configured and deadline reached',()=>{
  assert.equal(revealDue({...hold,automaticRevealArmed:false,automationConfigured:true},REVEAL_AT),false);
  assert.equal(revealDue({...hold,automaticRevealArmed:true,automationConfigured:false},REVEAL_AT),false);
  assert.equal(revealDue({...hold,automaticRevealArmed:true,automationConfigured:true},REVEAL_AT-1),false);
  assert.equal(revealDue({...hold,automaticRevealArmed:true,automationConfigured:true},REVEAL_AT),true);
});
console.log(JSON.stringify({suite:'corrected-release-guard',passed,realNetworkRequests:0,transactionsSent:0}));
