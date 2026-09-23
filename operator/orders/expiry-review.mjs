// Portable validation of trusted expiry evidence. This is not a retry grant.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
import {submissionBinding,validateBuyerSubmission} from './submission.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
const model=createOrderModel(policy),need=(v)=>{if(!v)throw Error('EXPIRY_RESPONSE');};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const exact=(v,fields)=>v&&Object.keys(v).sort().join(' ')===fields.split(' ').sort().join(' ');
export const expiryKey=order=>anchorKey(order).replace('buyer-blockhash:v1:','buyer-expiry:v1:');
const identity=input=>{
  const b=submissionBinding(input);
  return{orderIdentitySha256:input.claim.orderIdentitySha256,requestId:b.requestId,transactionSha256:b.transactionSha256,signature:b.signature};
};
export function validateBuyerExpiryResult(report,input){
  const binding=submissionBinding(input);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)&&report.cluster==='devnet'
    &&report.readyToSubmit===false&&report.salesOpen===false&&report.retryAuthorized===false);
  need(['expired','unknown'].includes(report.status));
  if(report.status==='unknown'){need(report.chainVerified===false&&!report.proof&&!report.evidence);return report;}
  const e=report.evidence,p=report.proof;
  need(report.chainVerified===true&&p?.kind==='expired'
    &&exact(e,'blockhash anchorSlot slot blockHeight lastValidBlockHeight historyPages historySha256')
    &&e.blockhash===input.claim.blockhash&&e.lastValidBlockHeight===input.claim.lastValidBlockHeight
    &&uint(e.anchorSlot)&&e.anchorSlot>0&&uint(e.slot)&&e.slot>=e.anchorSlot
    &&uint(e.blockHeight)&&e.blockHeight>e.lastValidBlockHeight
    &&uint(e.historyPages)&&e.historyPages>=1&&e.historyPages<=10&&typeof e.historySha256==='string'&&/^[a-f0-9]{64}$/.test(e.historySha256)
    &&p.slot===e.slot&&p.blockHeight===e.blockHeight&&p.statusSlot>=p.accountSlot);
  model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:1,proof:p});
  return report;
}
export function expiryRecord(input,report){
  validateBuyerExpiryResult(report,input);need(report.status==='expired');
  return{version:1,identity:identity(input),evidence:structuredClone(report.evidence),proof:structuredClone(report.proof)};
}
export function restoreExpiryReport(input,record){
  validateBuyerSubmission(input);
  need(exact(record,'version identity evidence proof')&&record.version===1
    &&JSON.stringify(record.identity)===JSON.stringify(identity(input)));
  return validateBuyerExpiryResult({...submissionBinding(input),cluster:'devnet',status:'expired',chainVerified:true,
    retryAuthorized:false,readyToSubmit:false,salesOpen:false,transactionsSent:0,networkRequests:0,restored:true,
    evidence:structuredClone(record.evidence),proof:structuredClone(record.proof)},input);
}
