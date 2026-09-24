// Disposable fixture signing only. No production wallet or custody keys.
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse} from '../../orders/signing.mjs';
export function closeAttempt(f,input,report){
  return{...input,order:f.model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:input.claim.attempt,proof:report.proof})};
}
export function replacementPartial(f,input,report){
  const prepared=prepareAssetClaim(input.order,report.candidate);
  const message=VersionedTransaction.deserialize(Buffer.from(prepared.claim.transactionBase64,'base64')).message.serialize();
  const signature=ed25519.sign(message,f.key('asset-'+input.order.id+'-0').secretKey.slice(0,32));
  return{order:prepared.order,claim:prepared.claim,request:finalizeAssetRequest(prepared.order,prepared.claim,signature)};
}
export function signReplacement(f,partial){
  let order=f.model.transitionOrder(partial.order,{type:'unknown',revision:partial.order.revision,index:0,attempt:2});
  const tx=VersionedTransaction.deserialize(Buffer.from(partial.request.transactionBase64,'base64'));tx.sign([f.owner]);
  const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  const signed=verifyBuyerSigningResponse(order,partial.claim,partial.request,response);
  order=f.model.transitionOrder(order,{type:'signature',revision:order.revision,index:0,attempt:2,signature:signed.signature,messageSha256:signed.messageSha256});
  return{...partial,order,response};
}
