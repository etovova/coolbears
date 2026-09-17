// One policy for browser, CI and the release installer. No network or signing.
export const CANDIDATE_HASH='4a5dcc56c96ab4bfb1815242b3e696ee1a1663c9f1254c893455d47bb746dc2b';
export const OWNER_RAW='0:6ea2cc995c7d4f236441c6c520b236c3e919ec54e331b4269528428c651a5717';
export const OWNER_FRIENDLY='UQBuosyZXH1PI2RBxsUgsjbD6RnsVOMxtCaVKEKMZRpXF9m7';
export const REVEAL_AT=1798761600;
const yes=(ok,msg)=>{if(!ok)throw new Error(msg);};
const hex64=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const flags=['testnetVerified','privateStorageVerified','mainnetVerified','creatorNftVerified','publicMintApproved','automaticRevealArmed'];
function evidence(s,key,p,hash){
 const e=s.evidence?.[key];
 yes(e&&e.status==='passed'&&e.packageSha256===hash&&e.codeHash===p.collectionCodeHash,`Missing or mismatched ${key} evidence`);
 yes(typeof e.checkedAt==='string'&&Number.isFinite(Date.parse(e.checkedAt)),`Missing ${key} check time`);
 if(key==='storage'){
  yes(e.revision==='v3'&&e.images===10000&&e.metadata===10000&&e.uniqueScores===10000, 'Incomplete collection backup');
  yes(hex64(e.manifestSha256)&&e.manifestSha256===p.releaseManifestSha256,'Storage manifest mismatch');
  yes(e.private===true,'Final assets must remain private until reveal');
 }else{
  yes(e.network===(key==='testnet'?'testnet':'mainnet'),'Wrong evidence network');
  yes(e.collectionAddressRaw===p.collectionAddressRaw,'Evidence is for another contract');
  yes(Array.isArray(e.transactionHashes)&&e.transactionHashes.length>0&&e.transactionHashes.every(hex64),'Missing verified transaction hashes');
  if(key==='creator')yes(e.tokenIndex===0&&e.ownerAddressRaw===OWNER_RAW,'Wrong creator reserve recipient');
 }
 return e;
}
export function validateLaunch(c,p,s,packageHash){
 yes(s?.schema===1&&['hold','prepared','approved','live'].includes(s.phase),'Unknown launch phase');
 yes(c&&p&&typeof c.demoMode==='boolean','Missing explicit mint mode');
 for(const key of flags)yes(typeof s[key]==='boolean',`Missing release flag: ${key}`);
 for(const [key,value] of Object.entries({network:'mainnet',priceTon:7,supply:10000,royaltyPercent:7,maxPerTransaction:50,revealDate:'2027-01-01',mintPaymentPerNftTon:7.1,mintPaymentPerNftNano:7100000000,treasuryAddress:OWNER_FRIENDLY,royaltyAddress:OWNER_FRIENDLY,collectionAddress:p.collectionAddressMainnetNonBounceable,mintContractAddress:p.collectionAddressMainnetBounceable,collectionCodeHash:p.collectionCodeHash}))yes(value!==undefined&&value!==''&&c[key]===value,`Site/package mismatch: ${key}`);
 yes(p.network==='mainnet'&&p.ownerAddressRaw===OWNER_RAW&&p.treasuryAddressRaw===OWNER_RAW,'Wrong owner, treasury or network');
 yes(p.supply===10000&&p.priceNanoTon===7000000000&&p.maxPerTransaction===50&&p.royaltyBps===700&&p.revealAt===REVEAL_AT,'Wrong contract policy');
 yes(p.initialPaused===true&&p.nextItemIndex===0,'Deployment must start paused');
 yes(s.candidateVersion==='committed-reveal-v1'&&s.candidateCodeHash===CANDIDATE_HASH,'Unknown release candidate');
 if(s.phase==='hold'){
  yes(c.demoMode===true&&!s.publicMintApproved&&!s.automaticRevealArmed,'Held release cannot sell or reveal');
  return {phase:'hold',setup:false,sales:false,automaticReveal:false};
 }
 yes(hex64(packageHash)&&s.packageSha256===packageHash,'Release is bound to different package bytes');
 yes(p.version==='committed-reveal-v1'&&p.collectionCodeHash===CANDIDATE_HASH,'Legacy package cannot be promoted');
 yes(hex64(p.finalContentCommitment)&&hex64(p.releaseManifestSha256),'Final commitment or manifest is missing');
 yes(s.testnetVerified&&s.privateStorageVerified,'Storage and end-to-end testnet verification required');
 evidence(s,'storage',p,packageHash);evidence(s,'testnet',p,packageHash);
 if(s.phase==='prepared'){
  yes(c.demoMode===true&&!s.publicMintApproved&&!s.automaticRevealArmed,'Preparation cannot open sales');
  return {phase:'prepared',setup:true,sales:false,automaticReveal:false};
 }
 yes(s.mainnetVerified&&s.creatorNftVerified&&s.publicMintApproved,'Mainnet, creator reserve and launch approval required');
 evidence(s,'mainnet',p,packageHash);evidence(s,'creator',p,packageHash);
 yes(c.demoMode===(s.phase!=='live'),'Site mode and approved phase disagree');
 if(s.automaticRevealArmed)yes(s.phase==='live'&&s.automationConfigured===true,'Reveal service is not configured');
 return {phase:s.phase,setup:true,sales:s.phase==='live',automaticReveal:s.automaticRevealArmed};
}
export function canOperate(action,gate,state,owner){
 if(owner!==true||!gate?.setup||!state)return false;
 if(action==='deploy')return gate.phase==='prepared'&&state.status==='uninitialized';
 if(state.status!=='active')return false;
 if(action==='claim')return state.minted===0&&state.paused===true;
 if(action==='unpause')return ['approved','live'].includes(gate.phase)&&Number.isInteger(state.minted)&&state.minted>=1&&state.paused===true&&state.creatorVerified===true;
 return false;
}
export function revealDue(state,seconds){return state?.phase==='live'&&state.automaticRevealArmed===true&&state.automationConfigured===true&&Number.isSafeInteger(seconds)&&seconds>=REVEAL_AT;}
