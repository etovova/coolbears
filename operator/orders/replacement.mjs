// Portable structural binding. Only retained terminal evidence authorizes preparation.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
import {prepareAssetClaim,validateAssetClaim,verifyBuyerEvidence,buyerRequestId} from './signing.mjs';
import {preparationFor} from './preparation.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
import {restoreExpiryReport} from './expiry-review.mjs';
import {restoreFailureReport} from './failure-record.mjs';
import {signedBytesId} from './submission.mjs';
const model=createOrderModel(policy),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const need=v=>{if(!v)throw Error('REPLACEMENT_BINDING');};
const exact=(v,names)=>v&&Object.keys(v).sort().join(' ')===names.split(' ').sort().join(' ');
export const replacementKey=order=>anchorKey(order).replace('buyer-blockhash:v1:','buyer-replacement:v1:');
export function validateReplacementSource(input){
  const {order,claim,request,response}=input;model.validateOrder(order);
  need(!order.paused&&order.cluster==='devnet'&&order.items[0].attempts.length===1&&['expired','failed'].includes(order.items[0].attempts[0].state)
    &&order.items.slice(1).every(i=>!i.attempts.length)&&claim.attempt===1);
  const signed=verifyBuyerEvidence(order,claim,request,response);
  need(order.items[0].attempts[0].signature===signed.signature);return signed;
}
export function validateReplacementPrior(input,prior){
  validateReplacementSource(input);need(same(input.order.items[0].attempts[0].proof,prior?.proof));
  const active=structuredClone(input.order);active.items[0].attempts[0].state='unknown';active.items[0].attempts[0].proof=null;
  (prior.proof.kind==='failed'?restoreFailureReport:restoreExpiryReport)({...input,order:active},prior);return prior;
}
export function validateReplacementAcknowledgment(input,prior,acknowledgedFeeLamports){
  validateReplacementPrior(input,prior);
  if(prior.proof.kind==='failed'){
    if(typeof acknowledgedFeeLamports!=='string'||acknowledgedFeeLamports!==prior.evidence.feeLamports)throw Error('PAID_FEE_ACKNOWLEDGMENT_REQUIRED');
  }else need(acknowledgedFeeLamports===undefined);
}
export const replacementAccountFloor=prior=>Math.max(prior.proof.slot,prior.proof.accountSlot,...(prior.proof.kind==='expired'?[prior.proof.statusSlot]:[]));
export const replacementSourceFloor=prior=>Math.max(replacementAccountFloor(prior),prior.proof.kind==='failed'?prior.evidence.statusSlot:0);
export function replacementBinding(input){
  const signed=validateReplacementSource(input);
  return{orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
    previousRequestId:buyerRequestId(input.request),previousTransactionSha256:signedBytesId(signed.transactionBase64),previousSignature:signed.signature};
}
const recordId=record=>signedBytesId(JSON.stringify({version:record.version,kind:record.kind,prior:record.prior,anchor:record.anchor,transactionBase64:record.transactionBase64,
  ...(record.version===2?{acknowledgedFeeLamports:record.acknowledgedFeeLamports}:{})}));
export function replacementCandidate(order,record){
  model.validateOrder(order);
  const failed=order.items[0].attempts[0]?.state==='failed';
  need(exact(record,'version kind prior anchor transactionBase64 replacementId'+(failed?' acknowledgedFeeLamports':''))
    &&record.version===(failed?2:1)&&record.kind==='coolbears-buyer-replacement'
    &&record.replacementId===recordId(record)&&order.items[0].attempts.length===1&&['expired','failed'].includes(order.items[0].attempts[0].state)
    &&same(order.items[0].attempts[0].proof,record.prior?.proof));
  if(failed)need(typeof record.acknowledgedFeeLamports==='string'&&record.acknowledgedFeeLamports===record.prior.evidence.feeLamports);
  const prepared=preparationFor(order,record.anchor,record.anchor.sourceSlot);
  need(same(prepared.anchor,record.anchor)&&prepared.candidate.transactionBase64===record.transactionBase64
    &&record.anchor.orderIdentitySha256===record.prior.identity.orderIdentitySha256
    &&record.anchor.sourceSlot>=replacementSourceFloor(record.prior)
    &&record.anchor.blockhash!==order.items[0].attempts[0].blockhash
    &&(failed?record.anchor.lastValidBlockHeight>order.items[0].attempts[0].lastValidBlockHeight:record.anchor.lastValidBlockHeight>record.prior.proof.blockHeight+80));
  return prepared.candidate;
}
export function replacementFor(input,prior,block,sourceSlot,acknowledgedFeeLamports){
  validateReplacementAcknowledgment(input,prior,acknowledgedFeeLamports);const {anchor,candidate}=preparationFor(input.order,block,sourceSlot),failed=prior.proof.kind==='failed';
  const record={version:failed?2:1,kind:'coolbears-buyer-replacement',prior:structuredClone(prior),anchor,transactionBase64:candidate.transactionBase64,
    ...(failed?{acknowledgedFeeLamports}:{})};
  record.replacementId=recordId(record);replacementCandidate(input.order,record);return record;
}
export function replacementReport(input,record,restored=false){
  validateReplacementAcknowledgment(input,record?.prior,record?.acknowledgedFeeLamports);need(typeof restored==='boolean');
  return{status:'replacement-prepared',...replacementBinding(input),record:structuredClone(record),candidate:replacementCandidate(input.order,record),
    restored,signaturesCreated:0,transactionsSent:0,readyToSign:false,readyToSubmit:false,salesOpen:false};
}
export function validateReplacementResult(report,input){
  const expected=replacementReport(input,report?.record,report?.restored);
  need(same(report,expected));return report;
}
export function validateReplacementClaim(order,claim,record){
  need(claim?.attempt===2);validateAssetClaim(order,claim);
  const before=structuredClone(order);before.items[0].attempts=before.items[0].attempts.slice(0,1);
  before.revision=claim.orderRevision-1;before.paused=false;
  const candidate=replacementCandidate(before,record),expected=prepareAssetClaim(before,candidate);
  need(same(expected.claim,claim));return record;
}
