import {validatePrewalletRecovery} from './prewallet-recovery.mjs';
const need=(v,c)=>{if(!v)throw Error(c);};
export function createBuyerPrewalletRecovery({storage,scope,transport}={}){
  need(typeof storage?.readPrewalletRecovery==='function'&&typeof storage?.savePrewalletRecovery==='function'
    &&typeof transport?.recoverPrewallet==='function','PREWALLET_CONFIGURATION');
  const frozen=structuredClone(scope);let busy=false;
  return Object.freeze({async recover(){need(!busy,'BUSY');busy=true;
    try{
      const state=await storage.readPrewalletRecovery(frozen);need(state,'PREWALLET_REQUIRED');
      if(['verified','failed'].includes(state.status))return{status:'already-recorded',outcome:state.status,
        ...(state.status==='failed'?{feeLamports:state.feeLamports}:{}),retryAuthorized:false,readyToSubmit:false,salesOpen:false};
      need(state.status==='prewallet-unknown','PREWALLET_REQUIRED');
      const report=validatePrewalletRecovery(await transport.recoverPrewallet(state.input),state.input);
      return report.status==='prewallet-recovered'?await storage.savePrewalletRecovery(frozen,report):report;
    }finally{busy=false;}
  }});
}
