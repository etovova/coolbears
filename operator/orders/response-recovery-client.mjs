// Explicit read-only operation with an atomic local result. No wallet or sender dependency.
import {validateResponseRecovery} from './response-recovery.mjs';
import {validateResponseExpiry} from './response-expiry.mjs';
const need=(v,code)=>{if(!v)throw Error(code);};
export function createBuyerResponseRecovery({storage,scope,transport}={}){
  need(storage&&typeof storage.readBuyerResponseRecovery==='function'&&typeof storage.saveRecoveredBuyerResponse==='function'
    &&typeof transport?.recoverResponse==='function','RESPONSE_RECOVERY_CONFIGURATION');
  const frozen=structuredClone(scope);let busy=false;
  return Object.freeze({async reviewExpiry({authorizeExpiryReview=false}={}){
    need(authorizeExpiryReview===true,'EXPLICIT_EXPIRY_REVIEW_REQUIRED');need(!busy,'BUSY');busy=true;
    try{
      need(typeof storage.saveBuyerResponseExpiry==='function'&&typeof transport.reviewResponseExpiry==='function','RESPONSE_EXPIRY_CONFIGURATION');
      const state=await storage.readBuyerResponseRecovery(frozen);need(state,'MISSING_RESPONSE_REQUIRED');
      if(state.status==='expired')return{status:'already-recorded',outcome:'expired',retryAuthorized:false,readyToSubmit:false,salesOpen:false};
      need(state.status==='wallet-response-unknown','MISSING_RESPONSE_REQUIRED');
      const report=validateResponseExpiry(await transport.reviewResponseExpiry(state.input),state.input);
      return report.status==='response-expired'?await storage.saveBuyerResponseExpiry(frozen,report):report;
    }finally{busy=false;}
  },async recoverMissingResponse(){
    need(!busy,'BUSY');busy=true;
    try{
      const state=await storage.readBuyerResponseRecovery(frozen);need(state,'MISSING_RESPONSE_REQUIRED');
      if(['verified','failed','expired'].includes(state.status))return{status:'already-recorded',outcome:state.status,
        ...(state.status==='failed'?{feeLamports:state.feeLamports}:{}),retryAuthorized:false,readyToSubmit:false,salesOpen:false};
      need(state.status==='wallet-response-unknown','MISSING_RESPONSE_REQUIRED');
      const report=validateResponseRecovery(await transport.recoverResponse(state.input),state.input);
      return report.status==='response-recovered'?await storage.saveRecoveredBuyerResponse(frozen,report):report;
    }finally{busy=false;}
  }});
}
