// An explicit trusted constructor profile, never an authorization from HTTP input.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import policy from '../../metadata/policy.json' with {type:'json'};
import {networkProfile} from '../deployment/network.mjs';
const fields=['version','kind','cluster','genesisHash','owner','collection','machine','guard','storageMode','hiddenCommitmentSha256','supply','publicItems','unitPriceLamports','royaltyBasisPoints','maxPerOrder','earliestRevealDate','website'];
const need=value=>{if(!value)throw Object.assign(Error('Public release profile is invalid.'),{code:'PUBLIC_RELEASE_PROFILE'});};
export function validatePublicReleaseProfile(value){
  need(value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===fields.length);
  for(const field of fields){const d=Object.getOwnPropertyDescriptor(value,field);need(d&&Object.hasOwn(d,'value'));}
  need(value.version===1&&value.kind==='coolbears-public-release-profile'&&value.cluster==='mainnet-beta'
    &&value.genesisHash===networkProfile('mainnet-beta').genesisHash&&value.owner===policy.owner
    &&value.storageMode==='hidden-settings'&&typeof value.hiddenCommitmentSha256==='string'
    &&/^[a-f0-9]{64}$/.test(value.hiddenCommitmentSha256)&&value.hiddenCommitmentSha256!=='0'.repeat(64)
    &&value.supply===10000&&value.supply===policy.supply&&value.publicItems===9999
    &&value.unitPriceLamports==='200000000'&&policy.priceSol===0.2&&value.royaltyBasisPoints===700
    &&policy.royaltyPercent===7&&value.maxPerOrder===50&&policy.maxPerOrder===50
    &&value.earliestRevealDate==='2027-01-01'&&policy.earliestRevealDate===value.earliestRevealDate
    &&value.website===policy.website&&value.website==='https://coolbears-nfts.com');
  for(const field of ['owner','collection','machine','guard']){
    let valid=false;try{valid=typeof value[field]==='string'&&new PublicKey(value[field]).toBase58()===value[field];}catch{}
    need(valid);
  }
  need(new Set(['owner','collection','machine','guard'].map(field=>value[field])).size===4);
  return Object.freeze(Object.fromEntries(fields.map(field=>[field,value[field]])));
}
export const publicReleaseProfileSha256=value=>createHash('sha256').update(JSON.stringify(validatePublicReleaseProfile(value))).digest('hex');
export function createPublicReleaseProfile({collection,machine,guard,hiddenCommitmentSha256}={}){
  return validatePublicReleaseProfile({version:1,kind:'coolbears-public-release-profile',cluster:'mainnet-beta',
    genesisHash:networkProfile('mainnet-beta').genesisHash,owner:policy.owner,collection,machine,guard,
    storageMode:'hidden-settings',hiddenCommitmentSha256,supply:10000,publicItems:9999,unitPriceLamports:'200000000',
    royaltyBasisPoints:700,maxPerOrder:50,earliestRevealDate:'2027-01-01',website:policy.website});
}
