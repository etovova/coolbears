// Test-only reconstruction of the persisted pre-response snapshot.
import {buyerRequestId} from '../../orders/signing.mjs';
export function missingResponse(signed,costApproval){
  const {order,claim,request}=structuredClone(signed);order.revision=claim.orderRevision+1;
  const attempt=order.items[0].attempts.at(-1);attempt.state='unknown';attempt.signature=null;
  return{order,claim,request,walletClaim:{version:costApproval?2:1,claimId:'c'.repeat(64),requestId:buyerRequestId(request),
    orderRevision:order.revision,...(costApproval?{costApproval}: {})}};
}
