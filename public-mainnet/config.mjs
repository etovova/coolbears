import {validateConsoleConfig} from '../operator/orders/buyer-console/config.mjs';
const need=(value)=>{if(!value)throw Error('PUBLIC_CONFIGURATION');};
export function validatePublicBuyerConfig(input){
  need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.hasOwn(input,'profileSha256'));
  const {profileSha256,...scope}=input,config=validateConsoleConfig(scope);
  need(config.version===2&&config.cluster==='mainnet-beta'&&config.storageMode==='hidden-settings'
    &&typeof profileSha256==='string'&&/^[a-f0-9]{64}$/.test(profileSha256)&&profileSha256!=='0'.repeat(64));
  return Object.freeze({...config,profileSha256});
}
export function buyerScopeConfig(input){const {profileSha256,...scope}=validatePublicBuyerConfig(input);return Object.freeze(scope);}
