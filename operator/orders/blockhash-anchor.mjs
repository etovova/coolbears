// Provenance is supplied only by the trusted gateway's durable RPC record.
// This structural validator does not authenticate a caller-supplied object.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
const need=(ok)=>{if(!ok)throw Object.assign(Error('BLOCKHASH_ANCHOR_REQUIRED'),{checkCode:'BLOCKHASH_ANCHOR_REQUIRED'});};
export const anchorKey=order=>'buyer-blockhash:v1:'+bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
  order.cluster,order.machine,order.collection,order.guard,order.buyer,order.items[0].asset]))));
export function validateBlockhashAnchor(anchor,claim){
  const fields=['version','orderIdentitySha256','messageSha256','blockhash','lastValidBlockHeight','sourceSlot'];
  need(anchor&&Object.keys(anchor).length===fields.length&&fields.every(k=>Object.hasOwn(anchor,k))&&anchor.version===1
    &&Number.isSafeInteger(anchor.sourceSlot)&&anchor.sourceSlot>=0
    &&Number.isSafeInteger(anchor.lastValidBlockHeight)&&anchor.lastValidBlockHeight>0
    &&['orderIdentitySha256','messageSha256','blockhash','lastValidBlockHeight'].every(k=>anchor[k]===claim[k]));
  return anchor;
}
