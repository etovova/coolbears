// Portable evidence binding. A discovered response is only usable with its terminal proof.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
import {validateAssetRequest,verifyBuyerSigningResponse,buyerRequestId} from './signing.mjs';
import {validateCostApproval} from './cost-approval.mjs';
import {signedBytesId,submissionBinding,validateBuyerResult} from './submission.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
const model=createOrderModel(policy),need=(v,code='RESPONSE_RECOVERY_BINDING')=>{if(!v)throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const shape=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
export const responseRecoveryKey=(order,attempt=1)=>anchorKey(order,attempt).replace('buyer-blockhash:v1:','buyer-response-recovery:v1:');
export function validateMissingBuyerResponse(input){
  need(shape(input,'order claim request walletClaim'),'MISSING_RESPONSE_FIELDS');
  const {order,claim,request,walletClaim:w}=input;model.validateOrder(order);validateAssetRequest(order,claim,request);
  need(order.cluster==='devnet'&&order.items[0].attempts.length===claim.attempt&&order.items[0].attempts.at(-1).state==='unknown'
    &&order.items[0].attempts.at(-1).signature===null&&order.items.slice(1).every(i=>!i.attempts.length),'MISSING_RESPONSE_STATE');
  need(w&&((w.version===1&&shape(w,'version claimId requestId orderRevision'))
    ||(w.version===2&&shape(w,'version claimId requestId orderRevision costApproval')))
    &&typeof w.claimId==='string'&&/^[a-f0-9]{64}$/.test(w.claimId)&&w.requestId===buyerRequestId(request)
    &&w.orderRevision===claim.orderRevision+1&&order.revision>=w.orderRevision,'WALLET_CLAIM_REQUIRED');
  if(w.version===2)validateCostApproval(w.costApproval,{order,claim,request});
  return input;
}
function identity(input){return{orderIdentitySha256:input.claim.orderIdentitySha256,requestId:buyerRequestId(input.request),
  partialSha256:signedBytesId(input.request.transactionBase64)};}
export function responseRecoveryBinding(input){validateMissingBuyerResponse(input);return{
  orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
  ...identity(input),walletClaimSha256:signedBytesId(JSON.stringify(input.walletClaim))};}
export function recoveredSubmission(input,response){
  validateMissingBuyerResponse(input);need(shape(response,'transactionBase64'));
  const signed=verifyBuyerSigningResponse(input.order,input.claim,input.request,response);
  const event={type:'signature',revision:input.order.revision,index:0,attempt:input.claim.attempt,
    signature:signed.signature,messageSha256:signed.messageSha256};
  return{event,input:{order:model.transitionOrder(input.order,event),claim:input.claim,request:input.request,
    response:{transactionBase64:signed.transactionBase64}}};
}
export function validateResponseRecovery(report,input){
  const binding=responseRecoveryBinding(input);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)&&report.cluster==='devnet'
    &&report.transactionsSent===0&&report.retryAuthorized===false&&report.readyToSubmit===false&&report.salesOpen===false
    &&typeof report.restored==='boolean'&&Number.isSafeInteger(report.networkRequests)&&report.networkRequests>=0);
  if(report.status==='response-recovered'){
    const recovered=recoveredSubmission(input,report.response);
    validateBuyerResult(report.result,recovered.input,{recovery:true});
    need(['verified','failed'].includes(report.result.status)&&report.result.transactionsSent===0);
  }else need(report.status==='unknown'&&report.response===undefined&&report.result===undefined);
  return report;
}
export function responseRecoveryReport(input,{response,result,networkRequests=0,restored=false,code}={}){
  return validateResponseRecovery({...responseRecoveryBinding(input),cluster:'devnet',status:response?'response-recovered':'unknown',
    transactionsSent:0,retryAuthorized:false,readyToSubmit:false,salesOpen:false,restored,networkRequests,
    ...(response?{response:structuredClone(response),result:structuredClone(result)}:{code:code??'RESPONSE_NOT_FOUND'})},input);
}
export function responseRecoveryRecord(input,report){
  validateResponseRecovery(report,input);need(report.status==='response-recovered');
  return{version:1,identity:{...identity(input),walletClaimSha256:signedBytesId(JSON.stringify(input.walletClaim))},
    response:structuredClone(report.response),proof:structuredClone(report.result.proof),
    ...(report.result.status==='failed'?{evidence:structuredClone(report.result.evidence)}:{})};
}
export function restoreDiscoveredSubmission(input,record){
  need(record?.version===1&&shape(record,record.proof?.kind==='failed'?'version identity response proof evidence':'version identity response proof')
    &&shape(record.identity,'orderIdentitySha256 requestId partialSha256 walletClaimSha256')
    &&typeof record.identity.walletClaimSha256==='string'&&/^[a-f0-9]{64}$/.test(record.identity.walletClaimSha256)
    &&Object.entries(identity(input)).every(([k,v])=>record.identity[k]===v)&&same(input.response,record.response));
  return validateBuyerResult({...submissionBinding(input),cluster:'devnet',status:record.proof.kind,chainVerified:true,
    transactionsSent:0,networkRequests:0,retryAuthorized:false,restored:true,readyToSubmit:false,salesOpen:false,
    proof:structuredClone(record.proof),...(record.evidence?{evidence:structuredClone(record.evidence)}:{})},input,{recovery:true});
}
export function restoreResponseRecovery(input,record){
  validateMissingBuyerResponse(input);need(record?.identity?.walletClaimSha256===signedBytesId(JSON.stringify(input.walletClaim)));
  const recovered=recoveredSubmission(input,record.response);
  return responseRecoveryReport(input,{response:record.response,result:restoreDiscoveredSubmission(recovered.input,record),restored:true});
}
