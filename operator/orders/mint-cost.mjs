// Complete quote for this exact, plugin-free, one-asset template only.
// Future items and failed attempts require independent fresh quotes.
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { none } from '@metaplex-foundation/umi';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { resolveStorageProfile } from '../storage-mode.mjs';
export const CORE_CREATE_LAMPORTS=1500000n;
const need=ok=>{if(!ok)throw Object.assign(Error('MINT_COST_UNVERIFIED'),{checkCode:'MINT_COST_UNVERIFIED'});};
function mintProfile(policy,order,storageOptions){
  let profile;try{profile=resolveStorageProfile(policy,storageOptions);}catch{need(false);}
  if(profile.storageMode==='hidden-settings')need(order.storageMode===profile.storageMode
    &&order.hiddenCommitmentSha256===profile.hiddenSettings.hash);
  else need(!Object.hasOwn(order,'storageMode')&&!Object.hasOwn(order,'hiddenCommitmentSha256'));
  return profile;
}
export function baseAssetBytes(policy,order,index='0001',storageOptions={}){
  const profile=mintProfile(policy,order,storageOptions),hidden=profile.storageMode==='hidden-settings';
  if(hidden)need(Number.isSafeInteger(index)&&index>=1&&index<policy.supply);
  return getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:order.buyer,
    updateAuthority:{__kind:'Collection',fields:[order.collection]},seq:none(),
    name:hidden?profile.hiddenSettings.name.replace('$ID+1$',String(index)):policy.hiddenName.replace('{index:04d}',index),
    uri:hidden?profile.hiddenSettings.uri.replace('$ID+1$',String(index)):`${policy.website}/metadata/hidden/${index}.json`});
}
export function verifySimulatedMintCost(policy,order,accounts,rent,options={}){
  const {expectedIndex,...storageOptions}=options;
  const profile=mintProfile(policy,order,storageOptions),hidden=profile.storageMode==='hidden-settings';
  need(typeof rent==='bigint'&&rent>0n);
  if(hidden)need(Number.isSafeInteger(expectedIndex)&&expectedIndex>=1&&expectedIndex<policy.supply);
  need(Array.isArray(accounts)&&accounts.length===1);const account=accounts[0];
  need(account?.owner===MPL_CORE_PROGRAM_ID&&account.executable===false
    &&Number.isSafeInteger(account.lamports)&&BigInt(account.lamports)===rent+CORE_CREATE_LAMPORTS
    &&Array.isArray(account.data)&&account.data.length===2&&account.data[1]==='base64'
    &&typeof account.data[0]==='string'&&account.data[0].length<=1024);
  const bytes=Buffer.from(account.data[0],'base64');need(bytes.toString('base64')===account.data[0]);
  if(account.space!==undefined)need(account.space===bytes.length);
  if(hidden){
    need(Buffer.from(baseAssetBytes(policy,order,expectedIndex,storageOptions)).equals(bytes));
    return CORE_CREATE_LAMPORTS;
  }
  let asset;try{[asset]=getAssetV1AccountDataSerializer().deserialize(bytes);}catch{need(false);}
  const index=asset.uri?.slice(-9,-5);
  need(typeof index==='string'&&/^[0-9]{4}$/.test(index)&&+index>=1&&+index<=9999
    &&Buffer.from(baseAssetBytes(policy,order,index)).equals(bytes));
  return CORE_CREATE_LAMPORTS;
}
