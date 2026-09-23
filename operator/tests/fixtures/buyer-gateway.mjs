// Synthetic full SDK account fixtures, never a live deployment or secret.
import { createHash } from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import approved from '../../../metadata/policy.json' with {type:'json'};
import { policy as nodePolicy } from '../../prepare.mjs';
import { buildDeploymentPlan } from '../../deployment/plan.mjs';
import { createOrderModel } from '../../orders/journal-model.mjs';
import { createOrderPlanner } from '../../orders/transaction-model.mjs';
import { prepareAssetClaim, finalizeAssetRequest } from '../../orders/signing.mjs';
import { insertionAccounts } from './group-accounts.mjs';
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
  const model=createOrderModel(policy),planner=createOrderPlanner(model),calls=[];
  let mode='normal',wait,entered;
  function input(id='gateway-fixture',quantity=1,buyer=policy.owner){
    const assets=Array.from({length:quantity},(_,n)=>key('asset-'+n));
    const order=model.createOrder({id,cluster:'devnet',buyer,machine:plan.roles.machine,collection:plan.roles.collection,guard:plan.roles.guard,
      quantity,available:9999,assets:assets.map(k=>k.publicKey.toBase58())});
    const block={blockhash:key('hash').publicKey.toBase58(),lastValidBlockHeight:2000};
    const unsigned=planner.buildOrderTransactions(order,block).templates[0].unsignedBytes;
    const old=approved.owner;approved.owner=policy.owner;
    try{
      const prepared=prepareAssetClaim(order,{orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(unsigned).toString('base64')});
      const signature=ed25519.sign(VersionedTransaction.deserialize(unsigned).message.serialize(),assets[0].secretKey.slice(0,32));
      return{order:prepared.order,claim:prepared.claim,request:finalizeAssetRequest(prepared.order,prepared.claim,signature)};
    }finally{approved.owner=old;}
  }
  async function upstream(request,ResponseType=Response){
    const url=new URL(request.url);if(url.origin!=='https://devnet.helius-rpc.com'||url.searchParams.get('api-key')!=='fixture-secret-42')throw Error('unexpected upstream');
    if(request.headers.has('cookie')||request.headers.has('authorization')||request.headers.has('origin'))throw Error('forwarded browser header');
    const call=await request.json();calls.push(call);entered?.();
    if(mode==='hold')await new Promise(resolve=>{wait=resolve;});
    if(mode==='429')return new ResponseType('fixture-secret-42',{status:429,headers:{'retry-after':'1'}});
    if(mode==='redirect')return new ResponseType('',{status:302,headers:{location:'https://forbidden.test/?secret=fixture-secret-42'}});
    const quantity=call.method==='getMultipleAccounts'?call.params[0].length-6:1;
    const results={getGenesisHash:mode==='genesis'?GENESIS_HASHES['mainnet-beta']:GENESIS_HASHES.devnet,
      getMultipleAccounts:{context:{slot:600},value:[...full.slice(0,3),full[5],full[6],full[3],...Array(quantity).fill(null)]},
      getBalance:{context:{slot:600},value:20000000000},getFeeForMessage:{context:{slot:600},value:10000},getMinimumBalanceForRentExemption:1999999,
      simulateTransaction:{context:{slot:600},value:{err:mode==='simulation'?{Custom:1}:null,unitsConsumed:99999}},
      isBlockhashValid:{context:{slot:600},value:mode!=='expired'},getBlockHeight:1800};
    if(!Object.hasOwn(results,call.method))throw Error('forbidden RPC '+call.method);
    return new ResponseType(JSON.stringify({jsonrpc:'2.0',id:call.id,result:results[call.method]}),{headers:{'content-type':'application/json'}});
  }
  return{policy,owner,plan,full,model,planner,key,input,calls,upstream,setMode:value=>{mode=value;},
    onRequest:callback=>{entered=callback;},release:()=>wait?.(),
    config:origin=>({version:1,cluster:'devnet',origin,machine:plan.roles.machine,collection:plan.roles.collection,guard:plan.roles.guard})};
}
