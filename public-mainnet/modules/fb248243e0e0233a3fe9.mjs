// Retained normalized evidence, not a retry grant or independent chain certificate.
import {networkProfile} from '/public-mainnet/modules/16494c413cb2c41805ca.mjs';
import {anchorKey} from '/public-mainnet/modules/59a7d0a819a7f7dfbf79.mjs';
import {submissionBinding,validateBuyerResult,validateFailureEvidence,signedBytesId} from '/public-mainnet/modules/9a2a0f7c701f6f0f8bae.mjs';
import {verifyBuyerEvidence,buyerRequestId} from '/public-mainnet/modules/8c19f4e554421cc56f55.mjs';
const networkIdentity=order=>order.cluster==='mainnet-beta'?{genesisHash:networkProfile(order.cluster).genesisHash}:{};
const need=v=>{if(!v)throw Error('FAILURE_RECORD');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const failureKey=(order,attempt=1,itemIndex=0)=>anchorKey(order,attempt,itemIndex).replace('buyer-blockhash:v1:','buyer-failure:v1:');
function identity(input){const b=submissionBinding(input);return{orderIdentitySha256:input.claim.orderIdentitySha256,
  requestId:b.requestId,transactionSha256:b.transactionSha256,signature:b.signature};}
export function failureRecord(input,report){
  validateBuyerResult(report,input,{recovery:true});need(report.status==='failed');
  return{version:1,identity:identity(input),evidence:structuredClone(report.evidence),proof:structuredClone(report.proof)};
}
export function restoreFailureReport(input,record){
  need(record&&Object.keys(record).sort().join(' ')==='evidence identity proof version'&&record.version===1&&same(record.identity,identity(input)));
  return validateBuyerResult({...submissionBinding(input),cluster:input.order.cluster,...networkIdentity(input.order),status:'failed',chainVerified:true,retryAuthorized:false,
    transactionsSent:0,networkRequests:0,restored:true,readyToSubmit:false,salesOpen:false,
    evidence:structuredClone(record.evidence),proof:structuredClone(record.proof)},input,{recovery:true});
}
// Historical terminal evidence only: no fabricated active revisions or wallet events.
export function validateHistoricalFailure(input,record){
  const signed=verifyBuyerEvidence(input.order,input.claim,input.request,input.response),attempt=input.order.items[input.claim.itemIndex].attempts[input.claim.attempt-1];
  need(attempt.state==='failed'&&same(attempt.proof,record?.proof)
    &&record&&Object.keys(record).sort().join(' ')==='evidence identity proof version'&&record.version===1
    &&same(record.identity,{orderIdentitySha256:input.claim.orderIdentitySha256,requestId:buyerRequestId(input.request),
      transactionSha256:signedBytesId(signed.transactionBase64),signature:signed.signature}));
  validateFailureEvidence(record.evidence,record.proof);return record;
}
