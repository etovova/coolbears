// Portable binding and validation. No network calls or permission to broadcast.
import {assertCurrentItem} from './sequential.mjs';
import policy from '../../metadata/policy.json' with {type:'json'};
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {createProtocolOrderModel} from './journal-model.mjs';
import {verifyBuyerSigningResponse,buyerRequestId} from './signing.mjs';
import {lamports} from './cost-approval.mjs';
import {networkProfile} from '../deployment/network.mjs';
const model=createProtocolOrderModel(policy),need=(v,code)=>{if(!v)throw Error(code);};
export const signedBytesId=bytes=>bytesToHex(sha256(new TextEncoder().encode(bytes)));
export function validateBuyerSubmission({order,claim,request,response}){
  model.validateOrder(order);networkProfile(order.cluster);assertCurrentItem(order,claim.itemIndex);
  need(order.revision>=claim.orderRevision+2&&order.items[claim.itemIndex].attempts.length===claim.attempt
    &&order.items[claim.itemIndex].attempts.at(-1).state==='unknown','SIGNED_ORDER_REQUIRED');
  const signed=verifyBuyerSigningResponse(order,claim,request,response);
  need(order.items[claim.itemIndex].attempts.at(-1).signature===signed.signature,'SAVED_RESPONSE_REQUIRED');
  return signed;
}
export function submissionBinding(input){const signed=validateBuyerSubmission(input);return{
  orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),requestId:buyerRequestId(input.request),
  transactionSha256:signedBytesId(signed.transactionBase64),signature:signed.signature};}
export function validateFailureEvidence(e,p){
  need(e&&Object.keys(e).sort().join(' ')==='errorSha256 feeLamports payerDebitLamports payerPostBalanceLamports payerPreBalanceLamports slot statusSlot'
    &&e.slot===p.slot&&Number.isSafeInteger(e.statusSlot)&&e.statusSlot>=p.accountSlot
    &&typeof e.errorSha256==='string'&&/^[a-f0-9]{64}$/.test(e.errorSha256),'FAILURE_EVIDENCE');
  const fee=lamports(e.feeLamports),before=lamports(e.payerPreBalanceLamports),after=lamports(e.payerPostBalanceLamports);
  need(fee>0n&&before>=after&&before-after===fee&&lamports(e.payerDebitLamports)===fee,'FAILURE_FEE_EVIDENCE');
  return e;
}
export function validateBuyerResult(report,input,{recovery=false}={}){
  const binding=submissionBinding(input);
  const network=networkProfile(input.order.cluster);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)
    &&report.cluster===network.cluster&&(network.cluster!=='mainnet-beta'||report.genesisHash===network.genesisHash)
    &&report.readyToSubmit===false&&report.salesOpen===false,'SUBMISSION_RESPONSE');
  if(recovery){
    need(['verified','failed','unknown'].includes(report.status),'SUBMISSION_RESPONSE');
    if(['verified','failed'].includes(report.status)){
      need(report.proof?.kind===report.status&&report.chainVerified===true,'SUBMISSION_RESPONSE');
      model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt,proof:report.proof});
      if(report.status==='failed'){
        need(report.retryAuthorized===false&&report.transactionsSent===0&&typeof report.restored==='boolean','FAILURE_EVIDENCE');
        validateFailureEvidence(report.evidence,report.proof);
      }
    }else need(report.chainVerified===false&&!report.proof,'SUBMISSION_RESPONSE');
  }else need(report.status==='accepted'&&report.chainVerified===false&&!report.proof,'SUBMISSION_RESPONSE');
  return report;
}
