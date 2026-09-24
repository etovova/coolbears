// Bounded positive discovery only. Missing history never proves absence or grants retry.
import {VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import {createDeploymentRpc,assertCluster,DeploymentRpcError} from '../deployment/rpc.mjs';
import {verifyFinalizedFailedTransaction} from '../deployment/receipt.mjs';
import {validateBlockhashAnchor} from './blockhash-anchor.mjs';
import {validatePrewalletInput,prewalletSubmission,prewalletRecoveryReport} from './prewallet-recovery.mjs';
import {recoverBuyerOrder} from './recovery.mjs';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{checkCode:code});};
const uint=v=>Number.isSafeInteger(v)&&v>=0;
export async function discoverPrewalletResult({input,blockhashAnchor,endpoint,fetchImpl,timeoutMs=12000}){
  const frozen=structuredClone(input);validatePrewalletInput(frozen);validateBlockhashAnchor(blockhashAnchor,frozen.claim);
  let rpc,extra=0;const started=performance.now();
  try{
    rpc=createDeploymentRpc({endpoint,fetchImpl,timeoutMs,totalTimeoutMs:30000,allowExpiryReads:true,maxResponseBytes:65536});
    await assertCluster(rpc,'devnet');
    const rows=await rpc.call('getSignaturesForAddress',[frozen.claim.asset,{commitment:'finalized',limit:10,minContextSlot:blockhashAnchor.sourceSlot}]);
    need(Array.isArray(rows)&&rows.length<10,'RESPONSE_HISTORY_LIMIT');
    const seen=new Set();let previous=Number.MAX_SAFE_INTEGER,matched;
    const partial=VersionedTransaction.deserialize(Buffer.from(frozen.claim.transactionBase64,'base64'));
    for(const row of rows){
      need(row&&typeof row.signature==='string'&&base58.serialize(row.signature).length===64
        &&base58.deserialize(base58.serialize(row.signature))[0]===row.signature&&!seen.has(row.signature)
        &&uint(row.slot)&&row.slot<=previous&&row.confirmationStatus==='finalized'&&Object.hasOwn(row,'err'),'RESPONSE_HISTORY');
      seen.add(row.signature);previous=row.slot;
      const transaction=await rpc.call('getTransaction',[row.signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
      need(transaction&&transaction.slot===row.slot&&transaction.version===0&&Array.isArray(transaction.transaction)
        &&transaction.transaction.length===2&&transaction.transaction[1]==='base64'&&typeof transaction.transaction[0]==='string'
        &&transaction.transaction[0].length<=1644,'RESPONSE_TRANSACTION');
      const bytes=Buffer.from(transaction.transaction[0],'base64');need(bytes.toString('base64')===transaction.transaction[0],'RESPONSE_TRANSACTION');
      const tx=VersionedTransaction.deserialize(bytes);
      need(Buffer.from(tx.serialize()).equals(bytes),'RESPONSE_TRANSACTION');
      if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(partial.message.serialize())))continue;
      const full=prewalletSubmission(frozen,{transactionBase64:transaction.transaction[0]});
      const signed={signature:full.order.items[0].attempts.at(-1).signature,transactionBase64:full.response.transactionBase64};
      need(signed.signature===row.signature&&row.slot>=blockhashAnchor.sourceSlot&&!matched,'RESPONSE_AMBIGUOUS');
      matched={row,transaction,response:{transactionBase64:signed.transactionBase64}};
    }
    need(matched,'RESPONSE_NOT_FOUND');
    const recovered=prewalletSubmission(frozen,matched.response);
    // The discovery and receipt stages share one monotonic deadline.
    const boundedFetch=(...args)=>{need(performance.now()-started<30000,'RESPONSE_DEADLINE');return fetchImpl(...args);};
    const result=await recoverBuyerOrder({input:recovered,endpoint,fetchImpl:boundedFetch,timeoutMs});extra=result.networkRequests;
    need(['verified','failed'].includes(result.status),result.code??'RESPONSE_NOT_VERIFIED');
    need(performance.now()-started<30000&&result.proof.slot===matched.row.slot,'RESPONSE_NOT_VERIFIED');
    if(result.status==='verified')need(matched.row.err===null&&matched.transaction.meta?.err===null,'RESPONSE_HISTORY_CONFLICT');
    else{
      const receipt=verifyFinalizedFailedTransaction({transactionBase64:matched.response.transactionBase64,transactionResult:matched.transaction,
        statusResult:{context:{slot:result.evidence.statusSlot},value:[{...matched.row,confirmations:null}]}});
      need(receipt.errorSha256===result.evidence.errorSha256,'RESPONSE_HISTORY_CONFLICT');
    }
    return prewalletRecoveryReport(frozen,{response:matched.response,result,networkRequests:rpc.requests+extra});
  }catch(error){return prewalletRecoveryReport(frozen,{networkRequests:(rpc?.requests??0)+extra,
    code:error instanceof DeploymentRpcError?'RPC_'+error.code:error?.checkCode??'RESPONSE_NOT_VERIFIED'});}
}
