// Trusted unsigned-attempt retirement. No fabricated signed bytes or retry grant.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
import {prewalletBinding,validatePrewalletInput} from './prewallet-recovery.mjs';
import {signedBytesId} from './submission.mjs';
import {anchorKey} from './blockhash-anchor.mjs';
const model=createOrderModel(policy),need=v=>{if(!v)throw Error('PREWALLET_EXPIRY_BINDING');};
const exact=(v,keys)=>v&&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' ');
const positive=n=>Number.isSafeInteger(n)&&n>0;
export const prewalletExpiryKey=(order,attempt=1)=>anchorKey(order,attempt).replace('buyer-blockhash:v1:','buyer-prewallet-expiry:v1:');
export function validatePrewalletExpiry(report,input){
  const binding=prewalletBinding(input);
  need(report&&Object.entries(binding).every(([k,v])=>report[k]===v)&&report.cluster==='devnet'
    &&report.transactionsSent===0&&report.retryAuthorized===false&&report.readyToSubmit===false&&report.salesOpen===false
    &&typeof report.restored==='boolean'&&Number.isSafeInteger(report.networkRequests)&&report.networkRequests>=0
    &&report.response===undefined&&report.result===undefined);
  if(report.status==='unknown'){need(report.chainVerified===false&&report.proof===undefined&&report.evidence===undefined);return report;}
  const e=report.evidence,p=report.proof;
  need(report.status==='prewallet-expired'&&report.chainVerified===true&&p?.kind==='expired'&&p.signature===null
    &&exact(e,'blockhash anchorSlot slot blockHeight lastValidBlockHeight historyPages historyTransactions historySha256')
    &&e.blockhash===input.claim.blockhash&&e.lastValidBlockHeight===input.claim.lastValidBlockHeight
    &&positive(e.anchorSlot)&&positive(e.slot)&&e.slot>=e.anchorSlot
    &&positive(e.blockHeight)&&e.blockHeight>e.lastValidBlockHeight
    &&positive(e.historyPages)&&e.historyPages<=2&&positive(e.historyTransactions)&&e.historyTransactions<=20
    &&e.historyTransactions>(e.historyPages-1)*10&&e.historyTransactions<=e.historyPages*10
    &&typeof e.historySha256==='string'&&/^[a-f0-9]{64}$/.test(e.historySha256)
    &&p.slot===e.slot&&p.blockHeight===e.blockHeight&&p.statusSlot===p.accountSlot);
  model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:input.claim.attempt,proof:p});
  return report;
}
export function prewalletExpiryReport(input,{proof,evidence,networkRequests=0,restored=false,code}={}){
  return validatePrewalletExpiry({...prewalletBinding(input),cluster:'devnet',status:proof?'prewallet-expired':'unknown',
    chainVerified:!!proof,transactionsSent:0,retryAuthorized:false,readyToSubmit:false,salesOpen:false,networkRequests,restored,
    ...(proof?{proof:structuredClone(proof),evidence:structuredClone(evidence)}:{code:code??'PREWALLET_EXPIRY_NOT_VERIFIED'})},input);
}
export function prewalletExpiryRecord(input,report){
  validatePrewalletExpiry(report,input);need(report.status==='prewallet-expired');
  // A late partial or pause may change the request binding, never the exact claim.
  return{version:1,claimSha256:signedBytesId(JSON.stringify(input.claim)),proof:structuredClone(report.proof),evidence:structuredClone(report.evidence)};
}
export function restorePrewalletExpiry(input,record){
  validatePrewalletInput(input);need(exact(record,'version claimSha256 proof evidence')&&record.version===1
    &&record.claimSha256===signedBytesId(JSON.stringify(input.claim)));
  return prewalletExpiryReport(input,{proof:record.proof,evidence:record.evidence,restored:true});
}
