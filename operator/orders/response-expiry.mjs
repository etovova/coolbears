// Retirement of an invoked wallet attempt with a genuinely missing response.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
import {responseRecoveryBinding,validateMissingBuyerResponse} from './response-recovery.mjs';
import {buyerRequestId} from './signing.mjs';
import {signedBytesId,submissionBinding,validateBuyerSubmission} from './submission.mjs';
import {validateBuyerExpiryResult} from './expiry-review.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
const model=createOrderModel(policy),need=v=>{if(!v)throw Error('RESPONSE_EXPIRY_BINDING');};
const exact=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
const positive=n=>Number.isSafeInteger(n)&&n>0,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const responseExpiryKey=(order,attempt=1)=>anchorKey(order,attempt).replace('buyer-blockhash:v1:','buyer-response-expiry:v1:');
function evidenceFor(input,p,e){
  need(p?.kind==='expired'&&p.signature===null
    &&exact(e,'blockhash anchorSlot slot blockHeight lastValidBlockHeight historyPages historyTransactions historySha256')
    &&e.blockhash===input.claim.blockhash&&e.lastValidBlockHeight===input.claim.lastValidBlockHeight
    &&positive(e.anchorSlot)&&positive(e.slot)&&e.slot>=e.anchorSlot
    &&positive(e.blockHeight)&&e.blockHeight>e.lastValidBlockHeight
    &&positive(e.historyPages)&&e.historyPages<=2&&positive(e.historyTransactions)&&e.historyTransactions<=20
    &&e.historyTransactions>(e.historyPages-1)*10&&e.historyTransactions<=e.historyPages*10&&hash(e.historySha256)
    &&p.slot===e.slot&&p.blockHeight===e.blockHeight&&p.statusSlot===p.accountSlot);
}
export function validateResponseExpiry(report,input){
  const binding=responseRecoveryBinding(input);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)&&report.cluster==='devnet'
    &&report.transactionsSent===0&&report.retryAuthorized===false&&report.readyToSubmit===false&&report.salesOpen===false
    &&typeof report.restored==='boolean'&&Number.isSafeInteger(report.networkRequests)&&report.networkRequests>=0
    &&report.response===undefined&&report.result===undefined);
  if(report.status==='unknown'){need(report.chainVerified===false&&report.proof===undefined&&report.evidence===undefined);return report;}
  need(report.status==='response-expired'&&report.chainVerified===true);evidenceFor(input,report.proof,report.evidence);
  model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:input.claim.attempt,proof:report.proof});
  return report;
}
export function responseExpiryReport(input,{proof,evidence,networkRequests=0,restored=false,code}={}){
  return validateResponseExpiry({...responseRecoveryBinding(input),cluster:'devnet',status:proof?'response-expired':'unknown',
    chainVerified:!!proof,transactionsSent:0,retryAuthorized:false,readyToSubmit:false,salesOpen:false,networkRequests,restored,
    ...(proof?{proof:structuredClone(proof),evidence:structuredClone(evidence)}:{code:code??'RESPONSE_EXPIRY_NOT_VERIFIED'})},input);
}
function identity(input){return{orderIdentitySha256:input.claim.orderIdentitySha256,requestId:buyerRequestId(input.request),
  partialSha256:signedBytesId(input.request.transactionBase64)};}
function validateRecord(input,record){
  need(exact(record,'version claimSha256 identity proof evidence')&&record.version===1
    &&record.claimSha256===signedBytesId(JSON.stringify(input.claim))
    &&exact(record.identity,'orderIdentitySha256 requestId partialSha256 walletClaimSha256')
    &&hash(record.identity.walletClaimSha256)&&Object.entries(identity(input)).every(([k,v])=>record.identity[k]===v));
  evidenceFor(input,record.proof,record.evidence);
}
export function responseExpiryRecord(input,report){
  validateResponseExpiry(report,input);need(report.status==='response-expired');
  return{version:1,claimSha256:signedBytesId(JSON.stringify(input.claim)),
    identity:{...identity(input),walletClaimSha256:signedBytesId(JSON.stringify(input.walletClaim))},
    proof:structuredClone(report.proof),evidence:structuredClone(report.evidence)};
}
export function restoreResponseExpiry(input,record){
  validateMissingBuyerResponse(input);validateRecord(input,record);
  need(record.identity.walletClaimSha256===signedBytesId(JSON.stringify(input.walletClaim)));
  return responseExpiryReport(input,{proof:record.proof,evidence:record.evidence,restored:true});
}
// A late genuine wallet response can consume the existing terminal proof via the
// explicit signed-expiry flow. The retained absence record never gains a signature.
export function restoreResponseExpirySubmission(input,record){
  const signed=validateBuyerSubmission(input);validateRecord(input,record);
  const {historyTransactions,...evidence}=structuredClone(record.evidence);
  return validateBuyerExpiryResult({...submissionBinding(input),cluster:'devnet',status:'expired',chainVerified:true,
    transactionsSent:0,networkRequests:0,restored:true,retryAuthorized:false,readyToSubmit:false,salesOpen:false,
    proof:{...structuredClone(record.proof),signature:signed.signature},evidence},input);
}
