// Synthetic full SDK account fixtures, never a live deployment or secret.
import { createHash } from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import approved from '../../../metadata/policy.json' with {type:'json'};
import { policy as nodePolicy } from '../../prepare.mjs';
import { buildDeploymentPlan } from '../../deployment/plan.mjs';
import { createOrderModel } from '../../orders/journal-model.mjs';
import { createOrderPlanner } from '../../orders/transaction-model.mjs';
import { prepareAssetClaim, finalizeAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from '../../orders/signing.mjs';
import { insertionAccounts } from './group-accounts.mjs';
import { none } from '@metaplex-foundation/umi';
import {base58} from '@metaplex-foundation/umi/serializers';
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { getAssetV1AccountDataSerializer } from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { inspectSignedDeploymentTransaction } from '../../deployment/signing.mjs';
import {createCostQuote,costQuoteKey} from '../../orders/cost-approval.mjs';
import {baseAssetBytes} from '../../orders/mint-cost.mjs';
import {preparationFor} from '../../orders/preparation.mjs';
import {anchorKey} from '../../orders/blockhash-anchor.mjs';
import { GENESIS_HASHES } from '../../deployment/rpc.mjs';
const key=label=>Keypair.fromSeed(createHash('sha256').update('buyer-gateway:'+label).digest());
export async function buyerGatewayFixture({syntheticOwner=false}={}){
  const owner=key('owner'),policy={...approved,owner:syntheticOwner?owner.publicKey.toBase58():approved.owner};
  const previous=[approved.owner,nodePolicy.owner];let plan,full;
  try{
    approved.owner=nodePolicy.owner=policy.owner;
    plan=await buildDeploymentPlan({cluster:'devnet',collection:key('collection').publicKey.toBase58(),reservedAsset:key('other').publicKey.toBase58(),
      machine:key('machine').publicKey.toBase58(),blockhash:key('hash').publicKey.toBase58(),lastValidBlockHeight:2000,machineRentLamports:'5000000000'});
    full=insertionAccounts({steps:plan.steps},9999);
  }finally{[approved.owner,nodePolicy.owner]=previous;}
  const model=createOrderModel(policy),planner=createOrderPlanner(model),calls=[],preparations=new Map(),costQuotes=new Map();
  let mode='normal',generation=1,wait,entered;const submitted=new Map();
  function receipt(bytes){
    const signed=inspectSignedDeploymentTransaction(bytes),tx=VersionedTransaction.deserialize(Buffer.from(bytes,'base64'));
    const asset=tx.message.staticAccountKeys[1].toBase58();
    submitted.set(signed.signature,{bytes,asset,buyer:tx.message.staticAccountKeys[0].toBase58(),generation:tx.message.recentBlockhash===key('hash').publicKey.toBase58()?1:2});return signed.signature;
  }
  function input(id='gateway-fixture',quantity=1,buyer=policy.owner){
    const assets=Array.from({length:quantity},(_,n)=>key('asset-'+id+'-'+n));
    const order=model.createOrder({id,cluster:'devnet',buyer,machine:plan.roles.machine,collection:plan.roles.collection,guard:plan.roles.guard,
      quantity,available:9999,assets:assets.map(k=>k.publicKey.toBase58())});
    const block={blockhash:key('hash').publicKey.toBase58(),lastValidBlockHeight:2000};
    const unsigned=planner.buildOrderTransactions(order,block).templates[0].unsignedBytes;
    const old=approved.owner;approved.owner=policy.owner;
    try{
      preparations.set(anchorKey(order),preparationFor(order,block,600));
      const prepared=prepareAssetClaim(order,{orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(unsigned).toString('base64')});
      const signature=ed25519.sign(VersionedTransaction.deserialize(unsigned).message.serialize(),assets[0].secretKey.slice(0,32));
      return{order:prepared.order,claim:prepared.claim,request:finalizeAssetRequest(prepared.order,prepared.claim,signature)};
    }finally{approved.owner=old;}
  }
  function signedInput(id='signed-fixture'){
    const value=input(id),old=approved.owner;approved.owner=policy.owner;
    try{
      value.order=model.transitionOrder(value.order,{type:'unknown',revision:1,index:0,attempt:1});
      const tx=VersionedTransaction.deserialize(Buffer.from(value.request.transactionBase64,'base64'));tx.sign([owner]);
      const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
      const signed=verifyBuyerSigningResponse(value.order,value.claim,value.request,response);
      value.order=model.transitionOrder(value.order,{type:'signature',revision:2,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
      return{...value,response};
    }finally{approved.owner=old;}
  }
  // Prior-stage tests inject these quotes explicitly; new consent tests use real HTTP issuance.
  function costApproval(value){
    const old=approved.owner;approved.owner=policy.owner;
    try{
      const report={status:'wallet-check-passed',orderRevision:1,orderId:value.order.id,readyToSign:true,
        checkedSlot:600,checkedAt:Date.now(),budget:{complete:true,scope:'next-item-current-template',projectionOnly:true,fullOrderTotalLamports:null,
          unitPriceLamports:value.order.unitPriceLamports,orderItemPriceLamports:value.order.totalPriceLamports,nextItemFeeLamports:'10000',nextItemBaseRentLamports:'1999999',
          protocolChargesLamports:'1500000',priorityFeeLamports:'0',nextItemKnownMinimumLamports:'203509999',projectedOrderTotalLamports:String(203509999n*BigInt(value.order.quantity)),balanceLamports:'20000000000'}};
      report.requestId=buyerRequestId(value.request);const quote=createCostQuote(value,report);costQuotes.set(costQuoteKey(quote.quoteId),quote);
      return{version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};
    }finally{approved.owner=old;}
  }
  async function upstream(request,ResponseType=Response){
    const url=new URL(request.url);if(url.origin!=='https://devnet.helius-rpc.com'||url.searchParams.get('api-key')!=='fixture-secret-42')throw Error('unexpected upstream');
    if(request.headers.has('cookie')||request.headers.has('authorization')||request.headers.has('origin'))throw Error('forwarded browser header');
    const call=await request.json();calls.push(call);entered?.();
    if(mode==='hold')await new Promise(resolve=>{wait=resolve;});
    if(mode==='429')return new ResponseType('fixture-secret-42',{status:429,headers:{'retry-after':'1'}});
    if(mode==='redirect')return new ResponseType('',{status:302,headers:{location:'https://forbidden.test/?secret=fixture-secret-42'}});
    if(call.method==='sendTransaction'){
      if(call.params[1].skipPreflight!==false||call.params[1].maxRetries!==0)throw Error('unsafe send fixture');
      const signature=receipt(call.params[0]);
      if(mode==='send-lost')throw Error('fixture-secret-42 lost acknowledgment');
      return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result:mode==='send-wrong'?'wrong-signature':signature}),{headers:{'content-type':'application/json'}});
    }
    const found=submitted.get(call.params?.[0]?.[0])??submitted.get(call.params?.[0]);
    if(mode.startsWith('expiry-')){
      const anchorSlot=generation===1?600:1200,horizon=generation===1?900:1600,height=generation===1?2100:2700;
      const row=(slot)=>({slot,signature:base58.deserialize(createHash('sha512').update('expiry-row:'+slot).digest())[0],err:null,confirmationStatus:'finalized'});
      const assetFound=call.method==='getMultipleAccounts'&&[...submitted.values()].some(v=>v.asset===call.params[0][0]);
      const results={getGenesisHash:GENESIS_HASHES.devnet,
        getBlock:call.params[0]===anchorSlot?{blockhash:key(generation===1?'hash':'replacement-hash').publicKey.toBase58(),blockHeight:generation===1?1800:2300,parentSlot:anchorSlot-1}:
          {blockhash:key('expiry-horizon').publicKey.toBase58(),blockHeight:height,parentSlot:horizon-1},
        isBlockhashValid:{context:{slot:horizon},value:mode==='expiry-live'},getFirstAvailableBlock:mode==='expiry-pruned'?anchorSlot+1:1,
        getSignatureStatuses:{context:{slot:horizon+100},value:[found||mode==='expiry-observed'?{slot:950,err:null,confirmationStatus:'finalized',confirmations:null}:null]},
        getTransaction:found?{slot:950,transaction:[found.bytes,'base64'],meta:{err:null}}:null,
        getMultipleAccounts:{context:{slot:horizon+50},value:[assetFound||mode==='expiry-asset'?{owner:MPL_CORE_PROGRAM_ID}:null]},
        getSignaturesForAddress:call.params[0]===policy.owner?(mode==='expiry-empty'?[]:[row(horizon-50),row(anchorSlot-1)]):(mode==='expiry-asset-history'?[row(850)]:[])};
      if(!Object.hasOwn(results,call.method))throw Error('forbidden expiry RPC '+call.method);
      return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result:results[call.method]}),{headers:{'content-type':'application/json'}});
    }
    if(['getSignatureStatuses','getTransaction'].includes(call.method)){
      const receiptSlot=found?.generation===2?1450:650,statusSlot=found?.generation===2?1500:700;
      const failureMode=mode.startsWith('failure-'),pending=mode==='pending'||mode==='failure-pending';
      const failed=mode==='failed'||failureMode?{InstructionError:[0,{Custom:1}]}:null;
      let failureMeta;
      if(found&&failureMode){
        const tx=VersionedTransaction.deserialize(Buffer.from(found.bytes,'base64'));
        const preBalances=Array(tx.message.staticAccountKeys.length).fill(2000000);preBalances[0]=20000000000;preBalances[1]=0;
        const postBalances=[...preBalances];postBalances[0]-=10000;
        failureMeta={fee:mode==='failure-no-fee'?null:10000,preBalances,postBalances};
      }
      let result=call.method==='getSignatureStatuses'?{context:{slot:statusSlot},value:[found&&mode!=='missing'?{
        slot:receiptSlot,confirmationStatus:pending?'confirmed':'finalized',confirmations:pending?2:null,err:failed}:null]}:
        found&&mode!=='missing'?{slot:receiptSlot,version:0,transaction:[mode==='wrong-bytes'?'AAAA':found.bytes,'base64'],meta:{err:failed,...failureMeta}}:null;
      return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result}),{headers:{'content-type':'application/json'}});
    }
    if(call.method==='getMultipleAccounts'&&call.params[0].length===1){
      const value=[...submitted.values()].find(v=>v.asset===call.params[0][0]);let account=null;
      if(value&&mode!=='absent-asset'&&(!mode.startsWith('failure-')||mode==='failure-asset')){
        const data=getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:mode==='wrong-owner'?key('stranger').publicKey.toBase58():value.buyer,
          updateAuthority:{__kind:'Collection',fields:[mode==='wrong-collection'?key('stranger').publicKey.toBase58():plan.roles.collection]},seq:none(),
          name:policy.hiddenName.replace('{index:04d}','0001'),uri:mode==='wrong-uri'?'https://foreign.test/1':policy.website+'/metadata/hidden/0001.json'});
        account={owner:MPL_CORE_PROGRAM_ID,executable:false,lamports:2000000,data:[Buffer.from(data).toString('base64'),'base64']};
      }
      return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result:{context:{slot:mode==='old-account'?600:value?.generation===2?1500:generation===2?1100:700},value:[account]}}),{headers:{'content-type':'application/json'}});
    }
    const slot=generation===2?1200:600;
    const quantity=call.method==='getMultipleAccounts'?call.params[0].length-6:1;
    let simulatedAccounts;
    if(call.method==='simulateTransaction'){
      const tx=VersionedTransaction.deserialize(Buffer.from(call.params[0],'base64'));
      if(JSON.stringify(call.params[1].accounts)!==JSON.stringify({encoding:'base64',addresses:[tx.message.staticAccountKeys[1].toBase58()]}))throw Error('missing simulated asset');
      const bytes=baseAssetBytes(policy,{buyer:tx.message.staticAccountKeys[0].toBase58(),collection:plan.roles.collection});
      simulatedAccounts=[{owner:MPL_CORE_PROGRAM_ID,executable:false,lamports:3499999,data:[Buffer.from(bytes).toString('base64'),'base64']}];
      if(mode==='cost-missing')simulatedAccounts=null;
      if(mode==='cost-wrong')simulatedAccounts[0].lamports++;
    }
    const results={getLatestBlockhash:{context:{slot},value:{blockhash:key(generation===2?'replacement-hash':'hash').publicKey.toBase58(),lastValidBlockHeight:generation===2?2600:2000}},getGenesisHash:mode==='genesis'?GENESIS_HASHES['mainnet-beta']:GENESIS_HASHES.devnet,
      getMultipleAccounts:{context:{slot},value:[...full.slice(0,3),full[5],full[6],full[3],...Array(quantity).fill(null)]},
      getBalance:{context:{slot},value:20000000000},getFeeForMessage:{context:{slot},value:mode==='fee-rise'?20000:10000},getMinimumBalanceForRentExemption:1999999,
      simulateTransaction:{context:{slot},value:{err:mode==='simulation'?{Custom:1}:null,unitsConsumed:99999,accounts:simulatedAccounts}},
      isBlockhashValid:{context:{slot},value:mode!=='expired'},getBlockHeight:mode==='near-expiry'?(generation===2?2550:1950):(generation===2?2300:1800)};
    if(!Object.hasOwn(results,call.method))throw Error('forbidden RPC '+call.method);
    return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result:results[call.method]}),{headers:{'content-type':'application/json'}});
  }
  return{policy,owner,plan,full,model,planner,key,input,preparations,costApproval,costQuotes,signedInput,calls,upstream,receipt,submitted,setMode:value=>{mode=value;},
    setGeneration:value=>{if(![1,2].includes(value))throw Error('fixture generation');generation=value;},
    onRequest:callback=>{entered=callback;},release:()=>wait?.(),
    config:origin=>({version:1,cluster:'devnet',origin,machine:plan.roles.machine,collection:plan.roles.collection,guard:plan.roles.guard})};
}
