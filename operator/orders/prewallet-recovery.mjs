// Positive terminal evidence for an existing native claim, without inventing a wallet claim.
import policy from '../../metadata/policy.json' with {type:'json'};
import {VersionedTransaction} from '@solana/web3.js';
import {createOrderModel} from './journal-model.mjs';
import {validateAssetClaim,validateAssetRequest,finalizeAssetRequest,verifyBuyerSigningResponse,buyerRequestId} from './signing.mjs';
import {validateHistoricalFailure} from './failure-record.mjs';
import {signedBytesId,submissionBinding,validateBuyerResult} from './submission.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
const model=createOrderModel(policy),need=(v,code='PREWALLET_RECOVERY_BINDING')=>{if(!v)throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const shape=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
export const prewalletRecoveryKey=(order,attempt=1)=>anchorKey(order,attempt).replace('buyer-blockhash:v1:','buyer-prewallet-recovery:v1:');
export function validatePrewalletInput(input){
  need(shape(input,'order claim request'),'PREWALLET_FIELDS');
  const {order,claim,request}=input;model.validateOrder(order);validateAssetClaim(order,claim);
  need(order.items[0].attempts.length===claim.attempt&&order.items[0].attempts.at(-1).state==='wallet-pending'
    &&order.items[0].attempts.at(-1).signature===null,'PREWALLET_STATE');
  if(request!==null)validateAssetRequest(order,claim,request);
  return input;
}
export function prewalletBinding(input){validatePrewalletInput(input);return{
  orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
  claimSha256:signedBytesId(JSON.stringify(input.claim)),requestSha256:input.request===null?null:signedBytesId(JSON.stringify(input.request))};}
export function prewalletSubmission(input,response){
  validatePrewalletInput(input);need(shape(response,'transactionBase64'));
  const value=response.transactionBase64;need(typeof value==='string'&&value.length>0&&value.length<=1644);
  const bytes=Buffer.from(value,'base64');need(bytes.toString('base64')===value&&bytes.length<=1232);
  const tx=VersionedTransaction.deserialize(bytes);need(Buffer.from(tx.serialize()).equals(bytes));
  // Reconstruct the partial from the observed asset signature, never a signing operation.
  const request=finalizeAssetRequest(input.order,input.claim,tx.signatures[1]);
  need(input.request===null||same(input.request,request),'PREWALLET_NATIVE_CONFLICT');
  const signed=verifyBuyerSigningResponse(input.order,input.claim,request,response);
  // Internal receipt-verifier projection only; these are not wallet claims/events.
  let order=model.transitionOrder(input.order,{type:'unknown',revision:input.order.revision,index:0,attempt:input.claim.attempt});
  order=model.transitionOrder(order,{type:'signature',revision:order.revision,index:0,attempt:input.claim.attempt,
    signature:signed.signature,messageSha256:signed.messageSha256});
  return{order,claim:input.claim,request,response:{transactionBase64:signed.transactionBase64}};
}
export function validatePrewalletRecovery(report,input){
  const binding=prewalletBinding(input);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)&&report.cluster==='devnet'
    &&report.transactionsSent===0&&report.retryAuthorized===false&&report.readyToSubmit===false&&report.salesOpen===false
    &&typeof report.restored==='boolean'&&Number.isSafeInteger(report.networkRequests)&&report.networkRequests>=0);
  if(report.status==='prewallet-recovered'){
    validateBuyerResult(report.result,prewalletSubmission(input,report.response),{recovery:true});
    need(['verified','failed'].includes(report.result.status)&&report.result.transactionsSent===0);
    model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:input.claim.attempt,proof:report.result.proof});
  }else need(report.status==='unknown'&&report.response===undefined&&report.result===undefined);
  return report;
}
export function prewalletRecoveryReport(input,{response,result,networkRequests=0,restored=false,code}={}){
  return validatePrewalletRecovery({...prewalletBinding(input),cluster:'devnet',status:response?'prewallet-recovered':'unknown',
    transactionsSent:0,retryAuthorized:false,readyToSubmit:false,salesOpen:false,networkRequests,restored,
    ...(response?{response:structuredClone(response),result:structuredClone(result)}:{code:code??'PREWALLET_NOT_FOUND'})},input);
}
export function prewalletRecoveryRecord(input,report){
  validatePrewalletRecovery(report,input);need(report.status==='prewallet-recovered');
  return{version:1,claimSha256:signedBytesId(JSON.stringify(input.claim)),response:structuredClone(report.response),
    proof:structuredClone(report.result.proof),...(report.result.status==='failed'?{evidence:structuredClone(report.result.evidence)}:{})};
}
export function restorePrewalletSubmission(input,record){
  need(record?.version===1&&shape(record,record.proof?.kind==='failed'?'version claimSha256 response proof evidence':'version claimSha256 response proof')
    &&record.claimSha256===signedBytesId(JSON.stringify(input.claim))&&same(record.response,input.response));
  return validateBuyerResult({...submissionBinding(input),cluster:'devnet',status:record.proof.kind,chainVerified:true,
    transactionsSent:0,networkRequests:0,retryAuthorized:false,restored:true,readyToSubmit:false,salesOpen:false,
    proof:structuredClone(record.proof),...(record.evidence?{evidence:structuredClone(record.evidence)}:{})},input,{recovery:true});
}
export function restorePrewalletRecovery(input,record){
  validatePrewalletInput(input);const full=prewalletSubmission(input,record?.response);
  return prewalletRecoveryReport(input,{response:record.response,result:restorePrewalletSubmission(full,record),restored:true});
}
export function prewalletFailurePrior(input,record){
  need(record?.version===1&&shape(record,'version claimSha256 response proof evidence')
    &&record.claimSha256===signedBytesId(JSON.stringify(input.claim))&&same(record.response,input.response)
    &&input.claim.attempt===1&&input.order.items[0].attempts.length===1,'PREWALLET_FAILURE_REQUIRED');
  return validateHistoricalFailure(input,{version:1,identity:{orderIdentitySha256:input.claim.orderIdentitySha256,
    requestId:buyerRequestId(input.request),transactionSha256:signedBytesId(input.response.transactionBase64),signature:input.order.items[0].attempts[0].signature},
    proof:structuredClone(record.proof),evidence:structuredClone(record.evidence)});
}
export function prewalletReplacementSource(order,claim,report){
  need(report?.status==='prewallet-recovered'&&report.result?.status==='failed','PREWALLET_FAILURE_REQUIRED');
  const record={version:1,claimSha256:report.claimSha256,response:structuredClone(report.response),
    proof:structuredClone(report.result.proof),evidence:structuredClone(report.result.evidence)};
  return prewalletFailureSource(order,claim,record);
}
export function prewalletFailureSource(order,claim,record){
  const tx=VersionedTransaction.deserialize(Buffer.from(record.response.transactionBase64,'base64'));
  const input={order:structuredClone(order),claim:structuredClone(claim),request:finalizeAssetRequest(order,claim,tx.signatures[1]),response:record.response};
  return{status:'failed',input,prewalletRecord:record,failureRecord:prewalletFailurePrior(input,record)};
}
