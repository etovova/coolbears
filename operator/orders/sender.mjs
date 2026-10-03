// Explicit current-item closed network send; local claim before HTTP, never automatic retry.
import {signedBytesId,validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
import {validateCostApproval} from './cost-approval.mjs';
import {validateBuyerExpiryResult} from './expiry-review.mjs';
import {validateReplacementResult,validateReplacementAcknowledgment} from './replacement.mjs';
import {networkProfile,networkSendAuthorized} from '../deployment/network.mjs';
const need=(v,code)=>{if(!v)throw Error(code);};
export function createBuyerSender({storage,scope,transport,storageManager=globalThis.navigator?.storage,authorizeMainnet=false}={}){
  need(storage&&transport&&typeof transport.send==='function'&&typeof transport.recover==='function','SENDER_CONFIGURATION');
  const frozenScope=structuredClone(scope),network=networkProfile(frozenScope?.cluster??'devnet');let busy=false;
  need(typeof authorizeMainnet==='boolean','SENDER_CONFIGURATION');
  need(network.cluster!=='mainnet-beta'||authorizeMainnet,'MAINNET_OPT_IN_REQUIRED');
  need(network.cluster==='mainnet-beta'||!authorizeMainnet,'MAINNET_SCOPE_REQUIRED');
  return Object.freeze({
    async sendOnce({authorizeDevnetSend=false,authorizeMainnetSend=false}={}){
      need(networkSendAuthorized(network.cluster,{authorizeDevnetSend,authorizeMainnetSend}),'EXPLICIT_SEND_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        let timer;try{need(await Promise.race([storageManager?.persisted?.(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PERSISTENT_STORAGE_REQUIRED')),5000);})])===true,'PERSISTENT_STORAGE_REQUIRED');}finally{clearTimeout(timer);}
        const before=await storage.readBuyerSubmission(frozenScope);need(before?.status==='ready'&&!before.input.order.paused,'SEND_NOT_READY');
        need(before.input.order.cluster===network.cluster,'SEND_CLUSTER_MISMATCH');
        validateBuyerSubmission(before.input);
        validateCostApproval(before.costApproval,before.input,{now:Date.now()});
        const claimed=await storage.claimBuyerSubmission(frozenScope,{orderRevision:before.input.order.revision,transactionSha256:signedBytesId(before.input.response.transactionBase64)});
        need(claimed.input?.order?.cluster===network.cluster,'SEND_CLUSTER_MISMATCH');
        need(claimed.status==='send-claimed'&&JSON.stringify(claimed.costApproval)===JSON.stringify(before.costApproval),'SEND_CLAIM_NOT_SAVED');
        validateCostApproval(claimed.costApproval,claimed.input,{now:Date.now()});
        // Any HTTP/storage/result failure retains this consumed claim. Only recover may follow.
        return validateBuyerResult(await transport.send(claimed.input,claimed.costApproval),claimed.input);
      }finally{busy=false;}
    },
    async recover(){
      need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state,'SAVED_RESPONSE_REQUIRED');
        need(state.input?.order?.cluster===network.cluster,'SEND_CLUSTER_MISMATCH');
        if(['verified','expired','failed'].includes(state.status))return{status:'already-recorded',outcome:state.status,signature:state.input.order.items[state.input.claim.itemIndex].attempts.at(-1).signature,
          ...(state.status==='failed'?{retryAuthorized:false,feeLamports:state.failureRecord.evidence.feeLamports}:{}),readyToSubmit:false,salesOpen:false};
        const report=validateBuyerResult(await transport.recover(state.input),state.input,{recovery:true});
        if(report.status==='failed'){
          need(typeof storage.saveBuyerFailure==='function','FAILURE_CONFIGURATION');return await storage.saveBuyerFailure(frozenScope,report);
        }
        return report.status==='verified'?await storage.saveBuyerProof(frozenScope,report):report;
      }finally{busy=false;}
    },
    async reviewExpiry({authorizeExpiryReview=false}={}){
      need(authorizeExpiryReview===true,'EXPLICIT_EXPIRY_REVIEW_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state&&!['verified','failed'].includes(state.status),'EXPIRY_NOT_READY');
        need(state.input?.order?.cluster===network.cluster,'SEND_CLUSTER_MISMATCH');
        if(state.status==='expired')return{status:'already-recorded',outcome:'expired',retryAuthorized:false,readyToSubmit:false,salesOpen:false};
        need(typeof transport.reviewExpiry==='function'&&typeof storage.saveBuyerExpiry==='function','EXPIRY_CONFIGURATION');
        const report=validateBuyerExpiryResult(await transport.reviewExpiry(state.input),state.input);
        return report.status==='expired'?await storage.saveBuyerExpiry(frozenScope,report):report;
      }finally{busy=false;}
    },
    async prepareReplacement({authorizeReplacement=false,acknowledgedFeeLamports}={}){
      need(authorizeReplacement===true,'EXPLICIT_REPLACEMENT_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state&&['expired','failed'].includes(state.status)&&state.input.claim.attempt===1&&!state.input.order.paused,'REPLACEMENT_NOT_READY');
        need(state.input?.order?.cluster===network.cluster,'SEND_CLUSTER_MISMATCH');
        if(state.status==='failed')validateReplacementAcknowledgment(state.input,state.failureRecord,acknowledgedFeeLamports);
        else need(acknowledgedFeeLamports===undefined,'REPLACEMENT_BINDING');
        need(typeof transport.replace==='function','REPLACEMENT_CONFIGURATION');
        const report=validateReplacementResult(await transport.replace(state.input,{acknowledgedFeeLamports}),state.input);
        need(report.record.acknowledgedFeeLamports===acknowledgedFeeLamports,'REPLACEMENT_BINDING');return report;
      }finally{busy=false;}
    },
  });
}
