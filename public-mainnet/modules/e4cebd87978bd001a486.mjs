// Replacement provenance for an expired native claim with no buyer signature.
// Structural validation only; the gateway must retain the exact expiry record.
import {assertCurrentItem} from '/public-mainnet/modules/a194ea6bf24e2ca920fe.mjs';
import policy from '/public-mainnet/modules/9753b87c4a3cad84685d.mjs';
import {createProtocolOrderModel} from '/public-mainnet/modules/c2e57714b2d49f910e34.mjs';
import {validateAssetClaim,validateAssetRequest} from '/public-mainnet/modules/8c19f4e554421cc56f55.mjs';
import {restorePrewalletExpiry} from '/public-mainnet/modules/bd9d06ad45627c2c9212.mjs';
import {signedBytesId} from '/public-mainnet/modules/9a2a0f7c701f6f0f8bae.mjs';
const model=createProtocolOrderModel(policy),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const need=v=>{if(!v)throw Error('PREWALLET_EXPIRY_REPLACEMENT_BINDING');};
const exact=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
export const isPrewalletExpiryReplacementInput=input=>exact(input,'order claim request');
function source(input,allowPaused){
  need(isPrewalletExpiryReplacementInput(input));
  const {order,claim,request}=input;model.validateOrder(order);validateAssetClaim(order,claim);
  const first=order.items[claim.itemIndex].attempts[0];
  need((allowPaused||!order.paused)&&claim.attempt===1
    &&order.items[claim.itemIndex].attempts.length===1
    &&first.state==='expired'&&first.signature===null&&first.proof?.signature===null);
  if(request!==null)validateAssetRequest(order,claim,request);
  assertCurrentItem(order,claim.itemIndex);return input;
}
export function validatePrewalletExpiryReplacementSource(input){return source(input,false);}
function priorFor(input,prior,allowPaused){
  source(input,allowPaused);need(same(input.order.items[input.claim.itemIndex].attempts[0].proof,prior?.proof));
  // This verification projection is never recorded as a new event or revision.
  const active=structuredClone(input);active.order.items[active.claim.itemIndex].attempts[0].state='wallet-pending';
  active.order.items[active.claim.itemIndex].attempts[0].proof=null;
  restorePrewalletExpiry(active,prior);return prior;
}
export function validatePrewalletExpiryReplacementPrior(input,prior){return priorFor(input,prior,false);}
export function prewalletExpiryReplacementBinding(input){
  validatePrewalletExpiryReplacementSource(input);
  return{orderId:input.order.id,orderRevision:input.order.revision,orderSha256:signedBytesId(JSON.stringify(input.order)),
    claimSha256:signedBytesId(JSON.stringify(input.claim)),requestSha256:input.request===null?null:signedBytesId(JSON.stringify(input.request)),
    previousSignature:null};
}
export function prewalletExpiryReplacementSource(order,claim,report,request=null){
  need(report?.status==='prewallet-expired'&&report.claimSha256===signedBytesId(JSON.stringify(claim)));
  const input=structuredClone({order,claim,request});
  const expiryRecord={version:1,claimSha256:report.claimSha256,proof:structuredClone(report.proof),evidence:structuredClone(report.evidence)};
  priorFor(input,expiryRecord,true);
  return{status:'expired',input,expiryRecord};
}
