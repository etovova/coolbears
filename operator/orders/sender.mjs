// Explicit first-item closed Devnet send; local claim before HTTP, never automatic retry.
import {signedBytesId,validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
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
        const claimed=await storage.claimBuyerSubmission(frozenScope,{orderRevision:before.input.order.revision,transactionSha256:signedBytesId(before.input.response.transactionBase64)});
        need(claimed.status==='send-claimed','SEND_CLAIM_NOT_SAVED');
        // Any HTTP/storage/result failure retains this consumed claim. Only recover may follow.
        return validateBuyerResult(await transport.send(claimed.input),claimed.input);
      }finally{busy=false;}
    },
    async recover(){
      need(!busy,'BUSY');busy=true;
      try{
        const state=await storage.readBuyerSubmission(frozenScope);need(state,'SAVED_RESPONSE_REQUIRED');
        if(state.status==='verified')return{status:'already-recorded',signature:state.input.order.items[0].attempts[0].signature,readyToSubmit:false,salesOpen:false};
        const report=validateBuyerResult(await transport.recover(state.input),state.input,{recovery:true});
        return report.status==='verified'?await storage.saveBuyerProof(frozenScope,report):report;
      }finally{busy=false;}
    },
  });
}
