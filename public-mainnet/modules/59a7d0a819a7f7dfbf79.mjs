// Provenance is supplied only by the trusted gateway's durable RPC record.
// This structural validator does not authenticate a caller-supplied object.
import { sha256 } from '/public-mainnet/modules/1b42fa37d934728f30a5.mjs';
import { bytesToHex } from '/public-mainnet/modules/c2cf7e49c894c8dcefe6.mjs';
const need=(ok)=>{if(!ok)throw Object.assign(Error('BLOCKHASH_ANCHOR_REQUIRED'),{checkCode:'BLOCKHASH_ANCHOR_REQUIRED'});};
export const attemptKey=(key,attempt=1)=>attempt===1?key:key+':attempt:'+attempt;
export const anchorKey=(order,attempt=1,itemIndex=0)=>attemptKey('buyer-blockhash:v1:'+bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
  order.cluster,order.machine,order.collection,order.guard,order.buyer,order.items[itemIndex].asset])))),attempt);
export function validateBlockhashAnchor(anchor,claim){
  const fields=['version','orderIdentitySha256','messageSha256','blockhash','lastValidBlockHeight','sourceSlot'];
  need(anchor&&Object.keys(anchor).length===fields.length&&fields.every(k=>Object.hasOwn(anchor,k))&&anchor.version===1
    &&Number.isSafeInteger(anchor.sourceSlot)&&anchor.sourceSlot>=0
    &&Number.isSafeInteger(anchor.lastValidBlockHeight)&&anchor.lastValidBlockHeight>0
    &&['orderIdentitySha256','messageSha256','blockhash','lastValidBlockHeight'].every(k=>anchor[k]===claim[k]));
  return anchor;
}
