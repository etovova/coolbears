import {validatePrewalletRecovery} from './prewallet-recovery.mjs';
import {validateReplacementResult,validateReplacementAcknowledgment} from './replacement.mjs';
const need=(v,c)=>{if(!v)throw Error(c);};
export function createBuyerPrewalletRecovery({storage,scope,transport}={}){
  need(typeof storage?.readPrewalletRecovery==='function'&&typeof storage?.savePrewalletRecovery==='function'
    &&typeof transport?.recoverPrewallet==='function','PREWALLET_CONFIGURATION');
  const frozen=structuredClone(scope);let busy=false;
  return Object.freeze({async prepareReplacement({authorizeReplacement=false,acknowledgedFeeLamports}={}){
    need(authorizeReplacement===true,'EXPLICIT_REPLACEMENT_REQUIRED');need(!busy,'BUSY');busy=true;
    try{
      need(typeof storage.readPrewalletReplacement==='function'&&typeof transport.replace==='function','REPLACEMENT_CONFIGURATION');
      const source=await storage.readPrewalletReplacement(frozen);
      need(source?.status==='failed'&&source.prewalletRecord&&source.input.claim.attempt===1&&!source.input.order.paused,'REPLACEMENT_NOT_READY');
      validateReplacementAcknowledgment(source.input,source.failureRecord,acknowledgedFeeLamports);
      const report=validateReplacementResult(await transport.replace(source.input,{acknowledgedFeeLamports}),source.input);
      need(JSON.stringify(report.record.prewallet)===JSON.stringify(source.prewalletRecord)
        &&report.record.acknowledgedFeeLamports===acknowledgedFeeLamports,'REPLACEMENT_HISTORY');return report;
    }finally{busy=false;}
  },async recover(){need(!busy,'BUSY');busy=true;
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
