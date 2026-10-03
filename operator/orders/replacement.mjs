// Portable structural binding. Only retained terminal evidence authorizes preparation.
import {assertCurrentItem,currentItemIndex} from './sequential.mjs';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createProtocolOrderModel} from './journal-model.mjs';
import {prepareAssetClaim,validateAssetClaim,validateAssetRequest,verifyBuyerEvidence,buyerRequestId} from './signing.mjs';
import {preparationFor} from './preparation.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
import {restoreExpiryReport} from './expiry-review.mjs';
import {validateHistoricalFailure} from './failure-record.mjs';
import {prewalletFailurePrior,prewalletFailureSource} from './prewallet-recovery.mjs';
import {isPrewalletExpiryReplacementInput,validatePrewalletExpiryReplacementSource,validatePrewalletExpiryReplacementPrior,
  prewalletExpiryReplacementBinding} from './prewallet-expiry-replacement.mjs';
import {isResponseExpiryReplacementInput,validateResponseExpiryReplacementSource,validateResponseExpiryReplacementPrior,
  responseExpiryReplacementBinding} from './response-expiry-replacement.mjs';
import {signedBytesId} from './submission.mjs';
const model=createProtocolOrderModel(policy),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const need=v=>{if(!v)throw Error('REPLACEMENT_BINDING');};
const exact=(v,names)=>v&&Object.keys(v).sort().join(' ')===names.split(' ').sort().join(' ');
export const replacementKey=(order,itemIndex=0)=>anchorKey(order,1,itemIndex).replace('buyer-blockhash:v1:','buyer-replacement:v1:');
export function validateReplacementSource(input){
  if(isResponseExpiryReplacementInput(input))return validateResponseExpiryReplacementSource(input);
  if(isPrewalletExpiryReplacementInput(input))return validatePrewalletExpiryReplacementSource(input);
  const {order,claim,request,response}=input;model.validateOrder(order);assertCurrentItem(order,claim.itemIndex);
  need(!order.paused&&order.items[claim.itemIndex].attempts.length===1&&['expired','failed'].includes(order.items[claim.itemIndex].attempts[0].state)
    &&claim.attempt===1);
  const signed=verifyBuyerEvidence(order,claim,request,response);
  need(order.items[claim.itemIndex].attempts[0].signature===signed.signature);return signed;
}
export function validateReplacementPrior(input,prior){
  if(isResponseExpiryReplacementInput(input))return validateResponseExpiryReplacementPrior(input,prior);
  if(isPrewalletExpiryReplacementInput(input))return validatePrewalletExpiryReplacementPrior(input,prior);
  validateReplacementSource(input);need(same(input.order.items[input.claim.itemIndex].attempts[0].proof,prior?.proof));
  if(prior.proof.kind==='failed')return validateHistoricalFailure(input,prior);
  const active=structuredClone(input.order);active.items[input.claim.itemIndex].attempts[0].state='unknown';active.items[input.claim.itemIndex].attempts[0].proof=null;
  restoreExpiryReport({...input,order:active},prior);return prior;
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
  if(isResponseExpiryReplacementInput(input))return responseExpiryReplacementBinding(input);
  if(isPrewalletExpiryReplacementInput(input))return prewalletExpiryReplacementBinding(input);
  const signed=validateReplacementSource(input);
  return{orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
    previousRequestId:buyerRequestId(input.request),previousTransactionSha256:signedBytesId(signed.transactionBase64),previousSignature:signed.signature};
}
const recordId=record=>signedBytesId(JSON.stringify({version:record.version,kind:record.kind,prior:record.prior,anchor:record.anchor,transactionBase64:record.transactionBase64,
  ...(record.version>=2?{acknowledgedFeeLamports:record.acknowledgedFeeLamports}:{}),...(record.version===3?{prewallet:record.prewallet}:{}),...(record.version===5?{responseExpiry:record.responseExpiry}:{}),...(record.originalClaim?{originalClaim:record.originalClaim}:{}),...(record.originalRequest?{originalRequest:record.originalRequest}:{})}));
export function replacementCandidate(order,record){
  model.validateOrder(order);
  const itemIndex=currentItemIndex(order);need(itemIndex!==null);assertCurrentItem(order,itemIndex);
  const item=order.items[itemIndex],first=item.attempts[0],failed=first?.state==='failed';
  need(exact(record,'version kind prior anchor transactionBase64 replacementId'+(failed?' acknowledgedFeeLamports':'')+(record.version===3?' prewallet':'')+(record.version===5?' responseExpiry':'')+(itemIndex>0?' originalClaim'+([1,2].includes(record.version)?' originalRequest':''):''))
    &&(failed?[2,3].includes(record.version):[1,4,5].includes(record.version))&&record.kind==='coolbears-buyer-replacement'
    &&record.replacementId===recordId(record)&&item.attempts.length===1&&['expired','failed'].includes(first.state)
    &&same(first.proof,record.prior?.proof));
  if(failed)need(typeof record.acknowledgedFeeLamports==='string'&&record.acknowledgedFeeLamports===record.prior.evidence.feeLamports);
  let original;
  if(itemIndex>0){
    // Later-item claims retain their real preparation revision: pauses and
    // recovery may have added any number of earlier events. Never guess it.
    original=record.originalClaim;validateAssetClaim(order,original);
    need(original.itemIndex===itemIndex&&original.attempt===1);
    const initial=structuredClone(order);initial.revision=original.orderRevision-1;initial.paused=false;initial.items[itemIndex].attempts=[];
    const expected=prepareAssetClaim(initial,preparationFor(initial,first,0).candidate).claim;
    need(same(original,expected));
    if([1,2].includes(record.version)){
      validateAssetRequest(order,original,record.originalRequest);
      need(record.prior.identity.orderIdentitySha256===original.orderIdentitySha256&&buyerRequestId(record.originalRequest)===record.prior.identity.requestId);
    }
  }else if([3,4,5].includes(record.version)){
    // Legacy first-item records retain their exact wire format and revision.
    const initial=structuredClone(order);initial.revision=0;initial.paused=false;initial.items[0].attempts=[];
    original=prepareAssetClaim(initial,preparationFor(initial,first,0).candidate).claim;
  }
  if(record.version===3)need(same(prewalletFailureSource(order,original,record.prewallet).failureRecord,record.prior));
  if(record.version===4)validatePrewalletExpiryReplacementPrior({order,claim:original,request:null},record.prior);
  if(record.version===5){need(exact(record.responseExpiry,'request walletClaim'));
    validateResponseExpiryReplacementPrior({order,claim:original,...record.responseExpiry},record.prior);}
  const prepared=preparationFor(order,record.anchor,record.anchor.sourceSlot);
  need(same(prepared.anchor,record.anchor)&&prepared.candidate.transactionBase64===record.transactionBase64
    &&record.anchor.orderIdentitySha256===(original?original.orderIdentitySha256:record.prior.identity.orderIdentitySha256)
    &&record.anchor.sourceSlot>=replacementSourceFloor(record.prior)
    &&record.anchor.blockhash!==first.blockhash
    &&(failed?record.anchor.lastValidBlockHeight>first.lastValidBlockHeight:record.anchor.lastValidBlockHeight>record.prior.proof.blockHeight+80));
  return prepared.candidate;
}
export function replacementFor(input,prior,block,sourceSlot,acknowledgedFeeLamports,prewallet){
  validateReplacementAcknowledgment(input,prior,acknowledgedFeeLamports);const {anchor,candidate}=preparationFor(input.order,block,sourceSlot),failed=prior.proof.kind==='failed';
  const unsigned=isPrewalletExpiryReplacementInput(input),missing=isResponseExpiryReplacementInput(input);
  if(unsigned||missing)need(prewallet===undefined);
  if(prewallet)need(failed&&same(prewalletFailurePrior(input,prewallet),prior));
  const record={version:missing?5:unsigned?4:prewallet?3:failed?2:1,kind:'coolbears-buyer-replacement',prior:structuredClone(prior),anchor,transactionBase64:candidate.transactionBase64,
    ...(failed?{acknowledgedFeeLamports}:{}),...(prewallet?{prewallet:structuredClone(prewallet)}:{}),
    ...(missing?{responseExpiry:{request:structuredClone(input.request),walletClaim:structuredClone(input.walletClaim)}}:{}),
    ...(input.claim.itemIndex>0?{originalClaim:structuredClone(input.claim),
      ...(!unsigned&&!missing&&!prewallet?{originalRequest:structuredClone(input.request)}:{})}:{})};
  record.replacementId=recordId(record);replacementCandidate(input.order,record);return record;
}
export function replacementReport(input,record,restored=false){
  validateReplacementAcknowledgment(input,record?.prior,record?.acknowledgedFeeLamports);need(typeof restored==='boolean');
  if(input.claim.itemIndex>0){need(same(record.originalClaim,input.claim));
    if([1,2].includes(record.version))need(same(record.originalRequest,input.request));}
  need((record.version===4)===isPrewalletExpiryReplacementInput(input)
    &&(record.version===5)===isResponseExpiryReplacementInput(input));
  if(record.version===5)need(same(record.responseExpiry,{request:input.request,walletClaim:input.walletClaim}));
  if(record.version===3)need(same(prewalletFailurePrior(input,record.prewallet),record.prior));
  return{status:'replacement-prepared',...replacementBinding(input),record:structuredClone(record),candidate:replacementCandidate(input.order,record),
    restored,signaturesCreated:0,transactionsSent:0,readyToSign:false,readyToSubmit:false,salesOpen:false};
}
export function validateReplacementResult(report,input){
  const expected=replacementReport(input,report?.record,report?.restored);
  need(same(report,expected));return report;
}
export function validateReplacementClaim(order,claim,record){
  need(claim?.attempt===2);validateAssetClaim(order,claim);
  const before=structuredClone(order);before.items[claim.itemIndex].attempts=before.items[claim.itemIndex].attempts.slice(0,1);
  // Historical validation reconstructs only the already bound earlier moment.
  before.items.slice(claim.itemIndex+1).forEach(item=>item.attempts=[]);
  before.revision=claim.orderRevision-1;before.paused=false;
  const candidate=replacementCandidate(before,record),expected=prepareAssetClaim(before,candidate);
  need(same(expected.claim,claim));return record;
}
