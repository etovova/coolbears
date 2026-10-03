// Outcome review from retained canonical evidence. No wallet, signing, send or write dependency.
import {validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
import {validateMissingBuyerResponse,validateResponseRecovery} from './response-recovery.mjs';
import {validatePrewalletInput,validatePrewalletRecovery} from './prewallet-recovery.mjs';
const need=(ok,code)=>{if(!ok)throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const terminal=status=>['verified','failed','expired'].includes(status);
const closed=()=>({mode:'read-only-recovery',readOnly:true,readyToSign:false,readyToSubmit:false,
  retryAuthorized:false,salesOpen:false,transactionsSent:0});
// Custody may change while the gateway reads. Every retained canonical field must not.
const evidence=value=>value&&Object.fromEntries(['order','assetSigning','buyerWallet','submission','responseRecovery','prewalletRecovery']
  .map(key=>[key,value[key]]));
function sourceOf(value){
  if(!value)return null;
  need(value.mode==='read-only-recovery'&&value.readOnly===true&&value.readyToSign===false
    &&value.readyToSubmit===false&&value.retryAuthorized===false&&value.salesOpen===false&&value.transactionsSent===0,
  'RECOVERY_SNAPSHOT_INVALID');
  let source,state,validate,method;
  if(value.submission){source='submission';state=value.submission;validate=validateBuyerSubmission;method='recover';}
  else if(value.responseRecovery){source='response';state=value.responseRecovery;validate=validateMissingBuyerResponse;method='recoverResponse';}
  else if(value.prewalletRecovery){source='prewallet';state=value.prewalletRecovery;validate=validatePrewalletInput;method='recoverPrewallet';}
  else return null;
  if(terminal(state.status)){
    need(value.order?.items[0]?.attempts.at(-1)?.state===state.status,'RECOVERY_SNAPSHOT_INVALID');
  }else{
    need(({submission:['ready','send-claimed'],response:['wallet-response-unknown'],prewallet:['prewallet-unknown']})[source].includes(state.status)
      &&same(state.input?.order,value.order),'RECOVERY_SNAPSHOT_INVALID');
    validate(state.input);
  }
  return{source,state,method};
}
function readOnlyReport(report){
  need(report?.transactionsSent===0&&report.readyToSubmit===false&&report.salesOpen===false
    &&(report.retryAuthorized===undefined||report.retryAuthorized===false)
    &&(report.readyToSign===undefined||report.readyToSign===false),'RECOVERY_RESPONSE_UNSAFE');
  if(report.result)readOnlyReport(report.result);
  return report;
}
export function createBuyerCustodyRecovery({storage,scope,transport}={}){
  need(typeof storage?.readRecoverySnapshot==='function','CUSTODY_RECOVERY_CONFIGURATION');
  const frozen=structuredClone(scope);let busy=false;
  const read=async()=>structuredClone(await storage.readRecoverySnapshot(structuredClone(frozen)));
  return Object.freeze({
    async snapshot(){
      need(!busy,'BUSY');busy=true;
      try{
        const value=await read(),chosen=sourceOf(value);
        return{...(value??{order:null,custody:null}),...closed(),status:chosen?.state.status??(value?'no-outcome-evidence':'missing-order'),
          source:chosen?.source??null,canCheck:!!chosen,busy:false};
      }finally{busy=false;}
    },
    async check({authorizeCheck=false}={}){
      need(authorizeCheck===true,'EXPLICIT_RECOVERY_CHECK_REQUIRED');need(!busy,'BUSY');busy=true;
      try{
        const before=await read(),chosen=sourceOf(before);need(chosen,'RECOVERY_EVIDENCE_REQUIRED');
        const {source,state,method}=chosen;
        if(terminal(state.status))return{...closed(),source,status:'already-recorded',outcome:state.status,custody:before.custody,
          ...(state.status==='failed'?{feeLamports:source==='submission'?state.failureRecord.evidence.feeLamports:state.feeLamports}:{})};
        need(typeof transport?.[method]==='function','CUSTODY_RECOVERY_CONFIGURATION');
        const input=structuredClone(state.input),baseline=evidence(before);
        // Give the transport a separate copy; dependency mutation cannot alter validation bindings.
        const response=await transport[method](structuredClone(input));
        const report=structuredClone(readOnlyReport(source==='submission'?validateBuyerResult(response,input,{recovery:true})
          :source==='response'?validateResponseRecovery(response,input):validatePrewalletRecovery(response,input)));
        const after=await read();sourceOf(after);
        need(same(evidence(after),baseline),'STALE_RECOVERY_SNAPSHOT');
        const result=source==='submission'?report:report.result,status=result?.status??'unknown';
        return{...closed(),source,status,...(terminal(status)?{outcome:status}:{}),custody:after.custody,report,
          ...(status==='failed'?{feeLamports:result.evidence.feeLamports}:{})};
      }finally{busy=false;}
    },
  });
}
