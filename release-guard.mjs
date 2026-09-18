// One fail-closed policy for browser, CI and the release installer.
// This module never performs network requests, signing or transactions.
export const CANDIDATE_HASH='4a5dcc56c96ab4bfb1815242b3e696ee1a1663c9f1254c893455d47bb746dc2b';
export const PACKAGE_SHA256='241bd1d8331f91361504474d87e745104eee75b99423cca472628d993bc1760f';
export const REVISION='v3-glasses-correction-1';
export const MANIFEST_SHA256='4d6dd18bf5050a9244862997e4a51ae9ba2026e656279745e7d4fee05213ce96';
export const CAR_SHA256='287406498c91a1791880bef7919a58c61e55a7dfd884aeb57c22a8ab49115b84';
export const OWNER_RAW='0:6ea2cc995c7d4f236441c6c520b236c3e919ec54e331b4269528428c651a5717';
export const OWNER_FRIENDLY='UQBuosyZXH1PI2RBxsUgsjbD6RnsVOMxtCaVKEKMZRpXF9m7';
export const REVEAL_AT=1798761600;
const yes=(ok,msg)=>{if(!ok)throw new Error(msg);};
const flags=['testnetVerified','privateStorageVerified','mainnetVerified','creatorNftVerified','publicMintApproved','automaticRevealArmed'];

function exactCandidate(p){
  yes(p?.version==='committed-reveal-v1','Wrong candidate version');
  yes(p.collectionRevision===REVISION,'Wrong collection revision');
  yes(p.network==='mainnet','Wrong candidate network');
  yes(p.collectionCodeHash===CANDIDATE_HASH,'Wrong collection code hash');
  yes(p.ownerAddressRaw===OWNER_RAW&&p.treasuryAddressRaw===OWNER_RAW,'Wrong owner or treasury');
  yes(p.supply===10000&&p.priceNanoTon===7000000000&&p.maxPerTransaction===50&&p.royaltyBps===700,'Wrong mint policy');
  yes(p.revealAt===REVEAL_AT&&p.initialPaused===true&&p.nextItemIndex===0,'Wrong initial/reveal policy');
  yes(p.releaseManifestSha256===MANIFEST_SHA256,'Wrong corrected manifest');
  yes(p.releaseCarSha256===CAR_SHA256,'Wrong corrected CAR');
  yes(typeof p.finalContentCommitment==='string'&&/^[a-f0-9]{64}$/.test(p.finalContentCommitment),'Missing final commitment');
}

function correctedPrerequisites(s,p,packageHash){
  yes(packageHash===PACKAGE_SHA256&&s.packageSha256===PACKAGE_SHA256,'Release is bound to different package bytes');
  yes(s.privateStorageVerified===true&&s.testnetVerified===true,'Corrected storage and TESTNET verification required');

  const ps=s.evidence?.privateStorage;
  yes(ps?.status==='passed'&&ps.packageSha256===PACKAGE_SHA256,'Corrected private storage evidence missing');
  yes(ps.collectionRevision===REVISION&&ps.manifestSha256===MANIFEST_SHA256&&ps.carSha256===CAR_SHA256,'Private storage release binding mismatch');
  yes(ps.partsExpected===48&&ps.partsVerified===48&&ps.allPartHashesVerified===true&&ps.fullReassemblyHashVerified===true,'Private CAR readback incomplete');

  const td=s.evidence?.correctedTestnetTransactionAudit;
  yes(td?.status==='passed'&&td.packageSha256===PACKAGE_SHA256&&td.appliesToCurrentCandidate===true,'Corrected TESTNET transaction audit missing');
  yes(td.transactionHistoryVerified===true&&td.receiptsMatchedByMessageHash===true&&td.collectionHistoryComplete===true,'TESTNET history proof incomplete');
  yes(JSON.stringify(td.operations)===JSON.stringify(['deploy','claim','open','mint']),'Unexpected TESTNET operation sequence');

  const n=s.evidence?.correctedTestnetNft0001;
  yes(n?.status==='verified-live-testnet'&&n.packageSha256===PACKAGE_SHA256&&n.appliesToCurrentCandidate===true,'Corrected TESTNET NFT evidence missing');
  yes(n.nextItemIndex===2&&n.paused===false&&n.nft0OwnerVerified===true&&n.nft1OwnerVerified===true&&n.nft0MetadataUriVerified===true&&n.nft1MetadataUriVerified===true,'TESTNET NFT proof incomplete');

  const media=s.evidence?.correctedPrerevealMedia;
  yes(media?.status==='passed'&&media.packageSha256===PACKAGE_SHA256&&media.appliesToCurrentCandidate===true,'Prereveal media evidence missing');
  yes(media.metadata0000Available===true&&media.metadata0001Available===true&&media.samePrerevealImage===true&&media.animatedGifVerified===true,'Prereveal media proof incomplete');
}

function mainnetProofs(s,p){
  const m=s.evidence?.correctedMainnetDeployment;
  yes(m?.status==='verified-live-mainnet'&&m.packageSha256===PACKAGE_SHA256&&m.appliesToCurrentCandidate===true,'Corrected mainnet deployment evidence missing');
  yes(m.collectionAddressRaw===p.collectionAddressRaw&&m.codeHash===CANDIDATE_HASH,'Mainnet deployment binding mismatch');
  yes(m.accountActive===true&&m.initialPausedVerified===true&&m.nextItemIndex===0,'Mainnet deployment state mismatch');

  const c=s.evidence?.correctedMainnetCreatorNft0000;
  yes(c?.status==='verified-live-mainnet'&&c.packageSha256===PACKAGE_SHA256&&c.appliesToCurrentCandidate===true,'Corrected mainnet creator evidence missing');
  yes(c.collectionAddressRaw===p.collectionAddressRaw&&c.nftIndex===0&&c.ownerAddressRaw===OWNER_RAW&&c.ownerVerified===true&&c.metadataUriVerified===true,'Mainnet creator NFT proof mismatch');
}

export function validateLaunch(c,p,s,packageHash){
  yes(s?.schema===1&&['hold','prepared','approved','live'].includes(s.phase),'Unknown launch phase');
  yes(c&&p&&typeof c.demoMode==='boolean','Missing explicit mint mode');
  for(const key of flags)yes(typeof s[key]==='boolean',`Missing release flag: ${key}`);
  exactCandidate(p);

  for(const [key,value] of Object.entries({
    network:'mainnet',priceTon:7,supply:10000,royaltyPercent:7,maxPerTransaction:50,
    revealDate:'2027-01-01',mintPaymentPerNftTon:7.1,mintPaymentPerNftNano:7100000000,
    treasuryAddress:OWNER_FRIENDLY,royaltyAddress:OWNER_FRIENDLY,
    collectionAddress:p.collectionAddressMainnetNonBounceable,
    mintContractAddress:p.collectionAddressMainnetBounceable,
    collectionCodeHash:p.collectionCodeHash
  })) yes(c[key]===value,`Site/package mismatch: ${key}`);

  yes(s.candidateVersion==='committed-reveal-v1'&&s.candidateRevision===REVISION&&s.candidateCodeHash===CANDIDATE_HASH,'Unknown release candidate');

  if(s.phase==='hold'){
    yes(c.demoMode===true&&!s.publicMintApproved&&!s.automaticRevealArmed,'Held release cannot sell, operate or reveal');
    yes(s.packageSha256===null||s.packageSha256===PACKAGE_SHA256,'Held state references an unknown package');
    return {phase:'hold',setup:false,sales:false,automaticReveal:false};
  }

  yes(s.packageSha256===PACKAGE_SHA256,'Launch state package binding mismatch');
  correctedPrerequisites(s,p,packageHash);

  if(s.phase==='prepared'){
    yes(c.demoMode===true&&!s.publicMintApproved&&!s.automaticRevealArmed,'Preparation cannot open sales or arm reveal');
    yes(s.mainnetVerified===false&&s.creatorNftVerified===false,'Prepared state must precede mainnet verification');
    return {phase:'prepared',setup:true,sales:false,automaticReveal:false};
  }

  yes(s.mainnetVerified===true&&s.creatorNftVerified===true,'Mainnet and creator reserve verification required');
  mainnetProofs(s,p);
  yes(s.publicMintApproved===true,'Explicit public mint approval required');
  yes(c.demoMode===(s.phase!=='live'),'Site mode and approved phase disagree');
  return {phase:s.phase,setup:true,sales:s.phase==='live',automaticReveal:s.automaticRevealArmed===true};
}

export function canOperate(action,gate,state,owner){
  if(owner!==true||!gate?.setup||!state)return false;
  if(action==='deploy')return gate.phase==='prepared'&&state.status==='uninitialized';
  if(state.status!=='active')return false;
  if(action==='claim')return ['prepared','approved','live'].includes(gate.phase)&&state.minted===0&&state.paused===true;
  if(action==='unpause')return ['approved','live'].includes(gate.phase)&&Number.isInteger(state.minted)&&state.minted>=1&&state.paused===true&&state.creatorVerified===true;
  return false;
}

export function revealDue(state,seconds){
  return state?.automaticRevealArmed===true&&state?.automationConfigured===true&&Number.isSafeInteger(seconds)&&seconds>=REVEAL_AT;
}
