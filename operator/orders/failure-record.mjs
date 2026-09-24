// Retained normalized evidence, not a retry grant or independent chain certificate.
import {anchorKey} from './blockhash-anchor.mjs';
import {submissionBinding,validateBuyerResult} from './submission.mjs';
const need=v=>{if(!v)throw Error('FAILURE_RECORD');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const failureKey=(order,attempt=1)=>anchorKey(order,attempt).replace('buyer-blockhash:v1:','buyer-failure:v1:');
function identity(input){const b=submissionBinding(input);return{orderIdentitySha256:input.claim.orderIdentitySha256,
  requestId:b.requestId,transactionSha256:b.transactionSha256,signature:b.signature};}
export function failureRecord(input,report){
  validateBuyerResult(report,input,{recovery:true});need(report.status==='failed');
  return{version:1,identity:identity(input),evidence:structuredClone(report.evidence),proof:structuredClone(report.proof)};
}
export function restoreFailureReport(input,record){
  need(record&&Object.keys(record).sort().join(' ')==='evidence identity proof version'&&record.version===1&&same(record.identity,identity(input)));
  return validateBuyerResult({...submissionBinding(input),cluster:'devnet',status:'failed',chainVerified:true,retryAuthorized:false,
    transactionsSent:0,networkRequests:0,restored:true,readyToSubmit:false,salesOpen:false,
    evidence:structuredClone(record.evidence),proof:structuredClone(record.proof)},input,{recovery:true});
}
