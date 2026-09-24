// Explicit first-item closed Devnet send; local claim before HTTP, never automatic retry.
import {signedBytesId,validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
import {validateCostApproval} from './cost-approval.mjs';
import {validateBuyerExpiryResult} from './expiry-review.mjs';
import {validateReplacementResult} from './replacement.mjs';
const need=(v,code)=>{if(!v)throw Error(code);};
export function createBuyerSender({storage,scope,transport,storageManager=globalThis.navigator?.storage}={}){
  need(storage&&transport&&typeof transport.send==='function'&&typeof transport.recover==='function','SENDER_CONFIGURATION');
  const frozenScope=structuredClone(scope);let busy=false;
  return Object.freeze({
    async sendOnce({authorizeDevnetSend=false}={}){
      need(authorizeDevnetSend===true,'EXPLICIT_SEND_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        let timer;try{need(await Promise.race([storageManager?.persisted?.(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PERSISTENT_STORAGE_REQUIRED')),5000);})])===true,'PERSISTENT_STORAGE_REQUIRED');}finally{clearTimeout(timer);}
        const before=await storage.readBuyerSubmission(frozenScope);need(before?.status==='ready'&&!before.input.order.paused,'SEND_NOT_READY');
        validateBuyerSubmission(before.input);
        validateCostApproval(before.costApproval,before.input,{now:Date.now()});
        const claimed=await storage.claimBuyerSubmission(frozenScope,{orderRevision:before.input.order.revision,transactionSha256:signedBytesId(before.input.response.transactionBase64)});
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
        if(['verified','expired'].includes(state.status))return{status:'already-recorded',outcome:state.status,signature:state.input.order.items[0].attempts.at(-1).signature,readyToSubmit:false,salesOpen:false};
        const report=validateBuyerResult(await transport.recover(state.input),state.input,{recovery:true});
        return report.status==='verified'?await storage.saveBuyerProof(frozenScope,report):report;
      }finally{busy=false;}
    },
    async reviewExpiry({authorizeExpiryReview=false}={}){
      need(authorizeExpiryReview===true,'EXPLICIT_EXPIRY_REVIEW_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state&&state.status!=='verified','EXPIRY_NOT_READY');
        if(state.status==='expired')return{status:'already-recorded',outcome:'expired',retryAuthorized:false,readyToSubmit:false,salesOpen:false};
        need(typeof transport.reviewExpiry==='function'&&typeof storage.saveBuyerExpiry==='function','EXPIRY_CONFIGURATION');
        const report=validateBuyerExpiryResult(await transport.reviewExpiry(state.input),state.input);
        return report.status==='expired'?await storage.saveBuyerExpiry(frozenScope,report):report;
      }finally{busy=false;}
    },
    async prepareReplacement({authorizeReplacement=false}={}){
      need(authorizeReplacement===true,'EXPLICIT_REPLACEMENT_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state?.status==='expired'&&state.input.claim.attempt===1&&!state.input.order.paused,'REPLACEMENT_NOT_READY');
        need(typeof transport.replace==='function','REPLACEMENT_CONFIGURATION');
        return validateReplacementResult(await transport.replace(state.input),state.input);
      }finally{busy=false;}
    },
  });
}
