// Trusted read orchestrator. Never submits, refreshes a hash or authorizes retry.
import policy from '../../metadata/policy.json' with {type:'json'};
import {lamports} from '@metaplex-foundation/umi';
import {deserializeAssetV1,Key,MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {createSigningRequest,verifySigningResponse} from '../deployment/signing.mjs';
import {verifyFinalizedReceipt} from '../deployment/receipt.mjs';
import {createDeploymentRpc,assertCluster,DeploymentRpcError} from '../deployment/rpc.mjs';
import {validateBuyerSubmission,submissionBinding} from './submission.mjs';
import {createOrderModel} from './journal-model.mjs';
const model=createOrderModel(policy),need=(v,code)=>{if(!v)throw Object.assign(Error(code),{checkCode:code});};
export async function recoverBuyerOrder({input,endpoint,fetchImpl,timeoutMs=12000}){
  const frozen=structuredClone(input),signed=validateBuyerSubmission(frozen),binding=submissionBinding(frozen);
  const fixed={...binding,cluster:'devnet',transactionsSent:0,readyToSubmit:false,salesOpen:false};let rpc;
  try{
    rpc=createDeploymentRpc({endpoint,fetchImpl,timeoutMs,totalTimeoutMs:30000});await assertCluster(rpc,'devnet');
    const statusResult=await rpc.call('getSignatureStatuses',[[signed.signature],{searchTransactionHistory:true}]);
    const transactionResult=await rpc.call('getTransaction',[signed.signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
    const request=createSigningRequest({deploymentId:frozen.order.id,stepId:'item-0',attempt:frozen.claim.attempt,cluster:'devnet',owner:frozen.order.buyer,
      transactionBase64:frozen.request.transactionBase64,lastValidBlockHeight:frozen.request.lastValidBlockHeight});
    const receipt=verifyFinalizedReceipt({request,signed:verifySigningResponse(request,{transactionBase64:signed.transactionBase64}),statusResult,transactionResult});
    const state=await rpc.call('getMultipleAccounts',[[frozen.claim.asset],{commitment:'finalized',encoding:'base64',minContextSlot:receipt.slot}]);
    need(Number.isSafeInteger(state?.context?.slot)&&state.context.slot>=receipt.slot&&Array.isArray(state.value)&&state.value.length===1,'ACCOUNT_CONTEXT');
    const raw=state.value[0];need(raw?.owner===MPL_CORE_PROGRAM_ID&&raw.executable===false&&Number.isSafeInteger(raw.lamports)&&raw.lamports>0
      &&Array.isArray(raw.data)&&raw.data.length===2&&raw.data[1]==='base64'&&typeof raw.data[0]==='string'&&raw.data[0].length<=65536,'ASSET_ACCOUNT');
    const data=Buffer.from(raw.data[0],'base64');need(data.toString('base64')===raw.data[0],'ASSET_ACCOUNT');
    const asset=deserializeAssetV1({publicKey:frozen.claim.asset,owner:raw.owner,executable:false,lamports:lamports(raw.lamports),data});
    need(asset.key===Key.AssetV1&&asset.owner===frozen.order.buyer&&asset.updateAuthority.type==='Collection'
      &&asset.updateAuthority.address===frozen.order.collection,'ASSET_ACCOUNT');
    const proof={kind:'verified',cluster:'devnet',machine:frozen.order.machine,collection:frozen.order.collection,buyer:frozen.order.buyer,
      asset:frozen.claim.asset,blockhash:frozen.claim.blockhash,messageSha256:signed.messageSha256,commitment:'finalized',slot:receipt.slot,
      signature:signed.signature,accountSlot:state.context.slot,account:{program:raw.owner,owner:asset.owner,collection:asset.updateAuthority.address,name:asset.name,uri:asset.uri}};
    model.transitionOrder(frozen.order,{type:'reconcile',revision:frozen.order.revision,index:0,attempt:frozen.claim.attempt,proof});
    return{...fixed,status:'verified',chainVerified:true,proof,networkRequests:rpc.requests};
  }catch(error){return{...fixed,status:'unknown',chainVerified:false,networkRequests:rpc?.requests??0,
    code:error instanceof DeploymentRpcError?'RPC_'+error.code:error?.checkCode??'RECOVERY_NOT_VERIFIED'};}
}
