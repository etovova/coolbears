// Trusted read-only RPC review of one saved signed attempt; no fresh hash or send.
import {verifyExpiredTransaction,DeploymentExpiryError} from '../deployment/expiry.mjs';
import {createDeploymentRpc,DeploymentRpcError} from '../deployment/rpc.mjs';
import {validateBlockhashAnchor} from './blockhash-anchor.mjs';
import {validateBuyerSubmission,submissionBinding} from './submission.mjs';
import {validateBuyerExpiryResult} from './expiry-review.mjs';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{checkCode:code});};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
export async function reviewBuyerExpiry({input,blockhashAnchor,endpoint,fetchImpl,timeoutMs=12000}){
  const value=structuredClone(input),signed=validateBuyerSubmission(value);
  const fixed={...submissionBinding(value),cluster:'devnet',transactionsSent:0,retryAuthorized:false,readyToSubmit:false,salesOpen:false};
  let rpc;
  try{
    const anchor=validateBlockhashAnchor(structuredClone(blockhashAnchor),value.claim);
    rpc=createDeploymentRpc({endpoint,fetchImpl,timeoutMs,totalTimeoutMs:30000,allowExpiryReads:true});
    const evidence=await verifyExpiredTransaction({transactionBase64:signed.transactionBase64,
      anchor:{version:1,blockhash:anchor.blockhash,lastValidBlockHeight:anchor.lastValidBlockHeight,slot:anchor.sourceSlot},call:rpc.call});
    const accounts=await rpc.call('getMultipleAccounts',[[value.claim.asset],{commitment:'finalized',encoding:'base64',minContextSlot:evidence.slot}]);
    need(uint(accounts?.context?.slot)&&accounts.context.slot>=evidence.slot&&Array.isArray(accounts.value)
      &&accounts.value.length===1&&accounts.value[0]===null,'EXPIRY_ASSET_OBSERVED');
    const history=await rpc.call('getSignaturesForAddress',[value.claim.asset,{commitment:'finalized',minContextSlot:accounts.context.slot,limit:1}]);
    need(Array.isArray(history)&&history.length===0,'EXPIRY_ASSET_HISTORY');
    const status=await rpc.call('getSignatureStatuses',[[signed.signature],{searchTransactionHistory:true}]);
    need(uint(status?.context?.slot)&&status.context.slot>=accounts.context.slot&&Array.isArray(status.value)
      &&status.value.length===1&&status.value[0]===null,'EXPIRY_TRANSACTION_OBSERVED');
    const proof={kind:'expired',cluster:'devnet',machine:value.order.machine,collection:value.order.collection,buyer:value.order.buyer,
      asset:value.claim.asset,blockhash:value.claim.blockhash,messageSha256:signed.messageSha256,commitment:'finalized',slot:evidence.slot,
      signature:signed.signature,blockhashValid:false,blockHeight:evidence.blockHeight,signatureAbsent:true,statusSlot:status.context.slot,
      accountAbsent:true,accountSlot:accounts.context.slot,addressHistoryEmpty:true};
    return validateBuyerExpiryResult({...fixed,status:'expired',chainVerified:true,proof,evidence,networkRequests:rpc.requests,restored:false},value);
  }catch(error){return{...fixed,status:'unknown',chainVerified:false,networkRequests:rpc?.requests??0,
    code:error instanceof DeploymentRpcError?'RPC_'+error.code:error instanceof DeploymentExpiryError?error.code:error?.checkCode??'EXPIRY_NOT_VERIFIED'};}
}
