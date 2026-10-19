// Complete disposable Hidden Settings transport. No real keys or live RPC.
import {createHash} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import policySource from '../../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from '../../orders/journal-model.mjs';
import {createOrderPlanner} from '../../orders/transaction-model.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse} from '../../orders/signing.mjs';
import {preparationFor} from '../../orders/preparation.mjs';
import {anchorKey} from '../../orders/blockhash-anchor.mjs';
import {baseAssetBytes,CORE_CREATE_LAMPORTS} from '../../orders/mint-cost.mjs';
import {GENESIS_HASHES} from '../../deployment/rpc.mjs';
import {networkProfile} from '../../deployment/network.mjs';
import {hiddenAccountFixtures,fixtureRpcAccount} from './hidden-accounts.mjs';
import {MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {base58} from '@metaplex-foundation/umi/serializers';
import {getAssetV1AccountDataSerializer} from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
const key=label=>Keypair.fromSeed(createHash('sha256').update('hidden-buyer-gateway:'+label).digest());
export function hiddenBuyerGatewayFixture({syntheticOwner=false,redeemed=999,hiddenCommitmentSha256='a'.repeat(64),cluster='devnet'}={}){
  const network=networkProfile(cluster);
  const owner=key('owner'),policy={...policySource,owner:syntheticOwner?owner.publicKey.toBase58():policySource.owner};
  const storageOptions={storageMode:'hidden-settings',hiddenCommitmentSha256};
  const roles={machine:key('machine').publicKey.toBase58(),collection:key('collection').publicKey.toBase58()};
  const accounts=hiddenAccountFixtures({policy,storageOptions,roles});roles.guard=accounts.guard;
  const model=createOrderModel(policy,storageOptions),planner=createOrderPlanner(model),calls=[],preparations=new Map();
  const block={blockhash:key('hash').publicKey.toBase58(),lastValidBlockHeight:2000};
  let mode='normal',initialRedeemed=redeemed,simulated=false;const observations=new Map();
  function withPolicy(fn){const before=policySource.owner;policySource.owner=policy.owner;try{return fn();}finally{policySource.owner=before;}}
  function order(id='hidden-gateway',quantity=1){return model.createOrder({id,cluster,buyer:policy.owner,...roles,quantity,available:9999,
    assets:Array.from({length:quantity},(_,i)=>key('asset-'+id+'-'+i).publicKey.toBase58())});}
  function input(id='hidden-gateway',quantity=1){return withPolicy(()=>{
    const fresh=order(id,quantity),template=planner.buildOrderTransactions(fresh,block).templates[0];
    preparations.set(anchorKey(fresh),preparationFor(fresh,block,600));
    const prepared=prepareAssetClaim(fresh,{orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(template.unsignedBytes).toString('base64')});
    const tx=VersionedTransaction.deserialize(template.unsignedBytes);tx.sign([key('asset-'+id+'-0')]);
    return{order:prepared.order,claim:prepared.claim,request:finalizeAssetRequest(prepared.order,prepared.claim,tx.signatures[1])};
  });}
  function signedInput(id='hidden-signed',quantity=1){
    if(!syntheticOwner)throw Error('SYNTHETIC_BUYER_REQUIRED');
    return withPolicy(()=>{const value=input(id,quantity);value.order=model.transitionOrder(value.order,{type:'unknown',revision:1,index:0,attempt:1});
      const tx=VersionedTransaction.deserialize(Buffer.from(value.request.transactionBase64,'base64'));tx.sign([owner]);
      const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')},signed=verifyBuyerSigningResponse(value.order,value.claim,value.request,response);
      value.order=model.transitionOrder(value.order,{type:'signature',revision:2,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});return{...value,response};});
  }
  const rent=bytes=>5080*(bytes+128);
  function observeResponse(value){
    if(!syntheticOwner)throw Error('SYNTHETIC_BUYER_REQUIRED');
    const tx=VersionedTransaction.deserialize(Buffer.from(value.response.transactionBase64,'base64'));
    const signature=base58.deserialize(tx.signatures[0])[0];
    observations.set(signature,{bytes:value.response.transactionBase64,asset:value.claim.asset,buyer:value.order.buyer,index:initialRedeemed+1});return signature;
  }
  function observedAccount(found){
    if(!found||mode==='failure-finalized'||mode==='absent-asset')return null;
    let data=baseAssetBytes(policy,{buyer:found.buyer,collection:roles.collection,...storageOptions},found.index,storageOptions);
    if(['legacy-uri','padded-uri','wrong-name'].includes(mode)){
      const serializer=getAssetV1AccountDataSerializer(),[record]=serializer.deserialize(data);
      if(mode==='legacy-uri')record.uri=policy.website+'/metadata/hidden/'+String(found.index).padStart(4,'0')+'.json';
      if(mode==='padded-uri')record.uri=policy.website+'/metadata/hidden-indexed/0'+found.index+'.json';
      if(mode==='wrong-name')record.name='CoolBears #'+found.index+' — Hidden Bear';
      data=serializer.serialize(record);
    }
    return fixtureRpcAccount(data,MPL_CORE_PROGRAM_ID,rent(data.length)+Number(CORE_CREATE_LAMPORTS));
  }
  async function upstream(request,ResponseType=Response){
    const url=new URL(request.url);if(url.origin!==new URL(network.rpcUpstream).origin||url.searchParams.get('api-key')!=='fixture-secret-42')throw Error('UNEXPECTED_SYNTHETIC_RPC');
    const call=await request.json();calls.push(call);
    if(call.method==='sendTransaction')throw Error('NO_NETWORK_DISPATCH_IN_HIDDEN_FIXTURE');
    const current=initialRedeemed+(mode==='stale-index'&&simulated?1:0),next=initialRedeemed+1,slot=initialRedeemed===redeemed?600:1000;
    let result;
    if(call.method==='getGenesisHash')result=mode==='wrong-genesis'?GENESIS_HASHES[cluster==='devnet'?'mainnet-beta':'devnet']:network.genesisHash;
    else if(call.method==='getLatestBlockhash')result={context:{slot},value:block};
    else if(call.method==='getBlockHeight')result=1800;
    else if(call.method==='isBlockhashValid')result={context:{slot},value:mode!=='expired'};
    else if(call.method==='getBalance')result={context:{slot},value:20000000000};
    else if(call.method==='getFeeForMessage')result={context:{slot},value:10000};
    else if(call.method==='getMinimumBalanceForRentExemption')result=rent(call.params[0]);
    else if(call.method==='getSignaturesForAddress')result=[...observations.entries()].filter(([,row])=>row.asset===call.params[0]).map(([signature])=>({signature,slot:650,err:mode==='failure-finalized'?{InstructionError:[0,{Custom:1}]}:null,confirmationStatus:'finalized'}));
    else if(call.method==='getSignatureStatuses')result={context:{slot:Math.max(750,slot)},value:call.params[0].map(signature=>observations.has(signature)?{slot:650,err:mode==='failure-finalized'?{InstructionError:[0,{Custom:1}]}:null,confirmationStatus:mode==='receipt-pending'?'confirmed':'finalized',confirmations:mode==='receipt-pending'?1:null}:null)};
    else if(call.method==='getTransaction'){
      const found=observations.get(call.params[0]);result=null;
      if(found){const tx=VersionedTransaction.deserialize(Buffer.from(found.bytes,'base64')),pre=Array(tx.message.staticAccountKeys.length).fill(2000000);pre[0]=20000000000;pre[1]=0;const post=[...pre];post[0]-=10000;
        result={slot:650,version:0,transaction:[mode==='wrong-receipt'?'AAAA':found.bytes,'base64'],meta:{err:mode==='failure-finalized'?{InstructionError:[0,{Custom:1}]}:null,
          ...(mode==='failure-finalized'?{fee:10000,preBalances:pre,postBalances:post}:{})}};}
    }
    else if(call.method==='getMultipleAccounts'&&call.params[0].length===1){
      const found=[...observations.values()].find(row=>row.asset===call.params[0][0]);
      result={context:{slot:Math.max(700,slot)},value:[observedAccount(found)]};
    }
    else if(call.method==='getMultipleAccounts'){
      const length=call.params[0].length;
      if(length<7)throw Error('HIDDEN_FIXTURE_FIRST_ITEM_ONLY');
      result={context:{slot},value:[{executable:true},{executable:true},{executable:true},accounts.machineAccount(current),
        accounts.guardAccount(mode==='wrong-price'?250000000n:undefined),accounts.collectionAccount(current),
        ...call.params[0].slice(6).map(asset=>observedAccount([...observations.values()].find(row=>row.asset===asset)))]};
    }else if(call.method==='simulateTransaction'){
      const tx=VersionedTransaction.deserialize(Buffer.from(call.params[0],'base64'));
      if(call.params[1].sigVerify!==false||call.params[1].replaceRecentBlockhash!==false)throw Error('HIDDEN_FIXTURE_UNSIGNED_ONLY');
      const expectedAddresses=[tx.message.staticAccountKeys[1].toBase58()];
      if(JSON.stringify(call.params[1].accounts?.addresses)!==JSON.stringify(expectedAddresses))throw Error('HIDDEN_FIXTURE_SIMULATION_ACCOUNT');
      const data=baseAssetBytes(policy,{buyer:tx.message.staticAccountKeys[0].toBase58(),collection:roles.collection,...storageOptions},mode==='wrong-index'?next+1:next,storageOptions);
      result={context:{slot},value:{err:null,unitsConsumed:99999,accounts:[fixtureRpcAccount(data,MPL_CORE_PROGRAM_ID,rent(data.length)+Number(CORE_CREATE_LAMPORTS))]}};simulated=true;
    }else throw Error('UNSUPPORTED_HIDDEN_SYNTHETIC_RPC');
    return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result}),{headers:{'content-type':'application/json'}});
  }
  return{policy,owner,storageOptions,roles,accounts,model,planner,block,calls,preparations,key,order,input,signedInput,withPolicy,upstream,observeResponse,observations,
    setMode:value=>{mode=value;simulated=false;},setRedeemed:value=>{initialRedeemed=value;simulated=false;},
    config:origin=>({version:2,cluster,origin,...roles,...storageOptions,
      ...(cluster==='mainnet-beta'?{genesisHash:network.genesisHash}:{})})};
}
