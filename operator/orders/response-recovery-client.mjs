// Explicit read-only operation with an atomic local result. No wallet or sender dependency.
import {validateResponseRecovery} from './response-recovery.mjs';
const need=(v,code)=>{if(!v)throw Error(code);};
export function createBuyerResponseRecovery({storage,scope,transport}={}){
  need(storage&&typeof storage.readBuyerResponseRecovery==='function'&&typeof storage.saveRecoveredBuyerResponse==='function'
    &&typeof transport?.recoverResponse==='function','RESPONSE_RECOVERY_CONFIGURATION');
  const frozen=structuredClone(scope);let busy=false;
  return Object.freeze({async recoverMissingResponse(){
    need(!busy,'BUSY');busy=true;
    try{
      const state=await storage.readBuyerResponseRecovery(frozen);need(state,'MISSING_RESPONSE_REQUIRED');
      if(['verified','failed'].includes(state.status))return{status:'already-recorded',outcome:state.status,
        ...(state.status==='failed'?{feeLamports:state.feeLamports}:{}),retryAuthorized:false,readyToSubmit:false,salesOpen:false};
      need(state.status==='wallet-response-unknown','MISSING_RESPONSE_REQUIRED');
      const report=validateResponseRecovery(await transport.recoverResponse(state.input),state.input);
      return report.status==='response-recovered'?await storage.saveRecoveredBuyerResponse(frozen,report):report;
    }finally{busy=false;}
  }});
}
