// A separate guard-open request domain using the unchanged native wire/Ed25519
// verifier. No deployment journal step is renamed or added by this module.
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {createSigningRequest,validateSigningRequest,verifySigningResponse} from '../deployment/signing.mjs';
import {verifyFinalizedReceipt} from '../deployment/receipt.mjs';
import {validatePublicReleaseProfile,publicReleaseProfileSha256} from './profile.mjs';
import {buildGuardOpenTemplate} from './guard-update.mjs';
const need=v=>{if(!v)throw Object.assign(Error('Public release signing input is invalid.'),{code:'PUBLIC_RELEASE_SIGNING'});};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&v!=='0'.repeat(64);
function exact(value,keys){need(value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length);for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);need(d&&Object.hasOwn(d,'value'));}}
function deploymentBinding(value){
  exact(value,['deploymentId','manifestSha256','revision','headHash']);
  need(typeof value.deploymentId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value.deploymentId)&&hash(value.manifestSha256)&&value.revision===38&&hash(value.headHash));
  return Object.freeze({deploymentId:value.deploymentId,manifestSha256:value.manifestSha256,revision:value.revision,headHash:value.headHash});
}
export function createGuardOpenSigningRequest({releaseId,profile,deployment,privateLaunchMappingProofSha256,blockhash,lastValidBlockHeight}={}){
  profile=validatePublicReleaseProfile(profile);deployment=deploymentBinding(deployment);
  need(typeof releaseId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(releaseId)&&hash(privateLaunchMappingProofSha256));
  const template=buildGuardOpenTemplate(profile,{blockhash,lastValidBlockHeight});
  const request=createSigningRequest({deploymentId:releaseId,stepId:'guard-open',attempt:1,cluster:profile.cluster,owner:profile.owner,
    transactionBase64:template.transactionBase64,lastValidBlockHeight});
  need(request.requiredSigners.length===1&&request.requiredSigners[0]===profile.owner);
  return Object.freeze({version:1,kind:'coolbears-public-release-signing-request',releaseId,stepId:'guard-open',attempt:1,
    profileSha256:publicReleaseProfileSha256(profile),deployment,privateLaunchMappingProofSha256,request});
}
export function validateGuardOpenSigningRequest(value,{profile,deployment,privateLaunchMappingProofSha256}={}){
  exact(value,['version','kind','releaseId','stepId','attempt','profileSha256','deployment','privateLaunchMappingProofSha256','request']);
  const native=validateSigningRequest(value.request);
  const expected=createGuardOpenSigningRequest({releaseId:value.releaseId,profile,deployment,privateLaunchMappingProofSha256,
    blockhash:native.blockhash,lastValidBlockHeight:native.lastValidBlockHeight});
  need(isDeepStrictEqual(value,expected));return expected;
}
export function guardOpenRequestSha256(value,context){return createHash('sha256').update(JSON.stringify(validateGuardOpenSigningRequest(value,context))).digest('hex');}
export function verifyGuardOpenSigningResponse(value,response,context){
  const expected=validateGuardOpenSigningRequest(value,context);return verifySigningResponse(expected.request,response);
}
export function verifyGuardOpenFinalizedReceipt(value,signed,{statusResult,transactionResult},context){
  const expected=validateGuardOpenSigningRequest(value,context);
  return verifyFinalizedReceipt({request:expected.request,signed,statusResult,transactionResult});
}
