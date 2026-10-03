// Replacement of an invoked wallet attempt whose genuine response stayed missing.
// Retains its native partial, wallet invocation and optional original cost consent.
import {assertCurrentItem} from './sequential.mjs';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createProtocolOrderModel} from './journal-model.mjs';
import {restoreResponseExpiry} from './response-expiry.mjs';
import {validateMissingBuyerResponse} from './response-recovery.mjs';
import {signedBytesId} from './submission.mjs';
const model=createProtocolOrderModel(policy),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const need=v=>{if(!v)throw Error('RESPONSE_EXPIRY_REPLACEMENT_BINDING');};
const exact=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
export const isResponseExpiryReplacementInput=input=>exact(input,'order claim request walletClaim');
function source(input,allowPaused){
  need(isResponseExpiryReplacementInput(input));
  const {order,claim}=input;model.validateOrder(order);
  const first=order.items[claim.itemIndex].attempts[0];
  need((allowPaused||!order.paused)&&claim.attempt===1
    &&order.items[claim.itemIndex].attempts.length===1
    &&first.state==='expired'&&first.signature===null&&first.proof?.signature===null);
  assertCurrentItem(order,claim.itemIndex);return input;
}
export function validateResponseExpiryReplacementSource(input){
  source(input,false);
  // Full invocation validation is applied to the retained proof in priorFor.
  const active=structuredClone(input);active.order.items[active.claim.itemIndex].attempts[0].state='unknown';active.order.items[active.claim.itemIndex].attempts[0].proof=null;
  validateMissingBuyerResponse(active);return input;
}
function priorFor(input,prior,allowPaused){
  source(input,allowPaused);need(same(input.order.items[input.claim.itemIndex].attempts[0].proof,prior?.proof));
  // Verification projection only; never a persisted history rewrite.
  const active=structuredClone(input);active.order.items[active.claim.itemIndex].attempts[0].state='unknown';active.order.items[active.claim.itemIndex].attempts[0].proof=null;
  restoreResponseExpiry(active,prior);return prior;
}
export function validateResponseExpiryReplacementPrior(input,prior){return priorFor(input,prior,false);}
export function responseExpiryReplacementBinding(input){
  validateResponseExpiryReplacementSource(input);
  return{orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
    claimSha256:signedBytesId(JSON.stringify(input.claim)),requestSha256:signedBytesId(JSON.stringify(input.request)),
    walletClaimSha256:signedBytesId(JSON.stringify(input.walletClaim)),previousSignature:null};
}
export function responseExpiryReplacementSource(order,claim,report,request,walletClaim){
  need(report?.status==='response-expired');
  const input=structuredClone({order,claim,request,walletClaim});
  const expiryRecord={version:1,claimSha256:signedBytesId(JSON.stringify(claim)),
    identity:{orderIdentitySha256:report.orderIdentitySha256,requestId:report.requestId,
      partialSha256:report.partialSha256,walletClaimSha256:report.walletClaimSha256},
    proof:structuredClone(report.proof),evidence:structuredClone(report.evidence)};
  priorFor(input,expiryRecord,true);return{status:'expired',input,expiryRecord};
}
