// Synthetic sequential Core account/receipt transport shared by Node and workerd tests.
import assert from 'node:assert/strict';
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import approved from '../../../metadata/policy.json' with {type:'json'};
import {createOrderChecker} from '../../orders/preflight-model.mjs';
import {createAccountVerifier} from '../../deployment/accounts-model.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse} from '../../orders/signing.mjs';
import {preparationFor} from '../../orders/preparation.mjs';
import {anchorKey} from '../../orders/blockhash-anchor.mjs';
import {baseAssetBytes} from '../../orders/mint-cost.mjs';
import {MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {GENESIS_HASHES} from '../../deployment/rpc.mjs';
import {getCandyMachineAccountDataSerializer as machineSerializer} from '../../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import {getCollectionV1AccountDataSerializer as collectionSerializer} from '../../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import {inspectSignedDeploymentTransaction} from '../../deployment/signing.mjs';
import {validateBuyerSubmission} from '../../orders/submission.mjs';
const origin='https://sequential-fixture.test',endpoint='https://sequential-fixture.test/rpc';
export function sequentialAssetAccount(order,index){return{owner:MPL_CORE_PROGRAM_ID,executable:false,lamports:3499999,
  data:[Buffer.from(baseAssetBytes(approved,order,String(index+1).padStart(4,'0'))).toString('base64'),'base64']};}
export function sequentialGatewayFixture(f,{quantity=3,prefix=1,prepared=false,signed=false,redeemed=9997,transform,allowFixtureSubmission=false}={}){
  assert.equal(typeof allowFixtureSubmission,'boolean');
  const block={blockhash:f.key('hash').publicKey.toBase58(),lastValidBlockHeight:2000};
  const checker=createOrderChecker(approved,{...f.model,...f.planner,...createAccountVerifier(approved)});
  const id='sequential-'+quantity+'-'+prefix,assets=Array.from({length:quantity},(_,i)=>f.key('asset-'+id+'-'+i));
  let order=f.model.createOrder({id,cluster:'devnet',buyer:f.policy.owner,machine:f.plan.roles.machine,
    guard:f.plan.roles.guard,collection:f.plan.roles.collection,quantity,available:9999,assets:assets.map(k=>k.publicKey.toBase58())});
  const transactions=new Map(),assetAccounts=new Map(),preparations=new Map();
  function prepare(index){
    const record=preparationFor(order,block,800);preparations.set(anchorKey(order,1,index),record);
    const p=prepareAssetClaim(order,record.candidate);order=p.order;
    const tx=VersionedTransaction.deserialize(Buffer.from(p.claim.transactionBase64,'base64'));
    const request=finalizeAssetRequest(order,p.claim,ed25519.sign(tx.message.serialize(),assets[index].secretKey.slice(0,32)));
    return{claim:p.claim,request,blockhashAnchor:record.anchor};
  }
  function sign(input,index){
    const tx=VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64'));tx.sign([f.owner]);
    const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
    const checked=verifyBuyerSigningResponse(order,input.claim,input.request,response);
    order=f.model.transitionOrder(order,{type:'unknown',revision:order.revision,index,attempt:1});
    order=f.model.transitionOrder(order,{type:'signature',revision:order.revision,index,attempt:1,signature:checked.signature,messageSha256:checked.messageSha256});
    return{response,checked};
  }
  for(let index=0;index<prefix;index++){
    const input=prepare(index),{response,checked}=sign(input,index),slot=650+index;
    const hidden=String(index+1).padStart(4,'0');
    const proof={kind:'verified',cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,
      asset:order.items[index].asset,blockhash:input.claim.blockhash,messageSha256:input.claim.messageSha256,
      commitment:'finalized',slot,signature:checked.signature,accountSlot:700+index,
      account:{program:MPL_CORE_PROGRAM_ID,owner:order.buyer,collection:order.collection,name:approved.hiddenName.replace('{index:04d}',hidden),uri:approved.website+'/metadata/hidden/'+hidden+'.json'}};
    order=f.model.transitionOrder(order,{type:'reconcile',revision:order.revision,index,attempt:1,proof});
    transactions.set(checked.signature,{slot,version:0,transaction:[response.transactionBase64,'base64'],meta:{err:null}});
    assetAccounts.set(order.items[index].asset,sequentialAssetAccount(order,index));
  }
  const readyOrder=structuredClone(order);let input;
  if(prepared||signed){input=prepare(prefix);if(signed)input={...input,...sign(input,prefix)};}
  const full=structuredClone(f.full),machineBytes=Buffer.from(full[5].data[0],'base64');
  const [machine]=machineSerializer().deserialize(machineBytes);
  machineBytes.set(machineSerializer().serialize({...machine,itemsRedeemed:BigInt(redeemed)}));full[5].data[0]=machineBytes.toString('base64');
  const collectionBytes=Buffer.from(full[3].data[0],'base64'),[collection]=collectionSerializer().deserialize(collectionBytes);
  collectionBytes.set(collectionSerializer().serialize({...collection,numMinted:redeemed+1,currentSize:redeemed+1}));full[3].data[0]=collectionBytes.toString('base64');
  const calls=[];let accountReads=0,fixtureSubmissions=0,submissionGrant;
  function expectFixtureSubmission(value){
    assert.equal(allowFixtureSubmission,true,'Fixture submission is disabled');
    assert.equal(fixtureSubmissions,0,'Fixture submission is one-shot');
    assert.equal(submissionGrant,undefined,'Fixture grant already exists');
    assert.deepEqual(value.claim,input?.claim);assert.deepEqual(value.request,input?.request);
    assert.equal(value.claim.itemIndex,prefix);assert.equal(value.claim.asset,assets[prefix].publicKey.toBase58());
    submissionGrant=validateBuyerSubmission(value);
  }
  const fetchImpl=async(_url,init)=>{
    const call=JSON.parse(init.body);calls.push(call);
    let result;
    switch(call.method){
      case 'sendTransaction':
        assert.equal(allowFixtureSubmission,true,'Fixture submission is disabled');assert.ok(submissionGrant,'Exact fixture grant required');
        assert.equal(fixtureSubmissions,0,'Fixture submission is one-shot');assert.equal(call.params[0],submissionGrant.transactionBase64);
        assert.deepEqual(call.params[1],{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot:850});
        result=submissionGrant.signature;submissionGrant=undefined;fixtureSubmissions++;break;
      case 'getGenesisHash':result=GENESIS_HASHES.devnet;break;
      case 'getMultipleAccounts':accountReads++;result={context:{slot:800},value:call.params[0].length===1
        ?call.params[0].map(asset=>assetAccounts.get(asset)??null)
        :[...full.slice(0,3),full[5],full[6],full[3],...order.items.map(i=>assetAccounts.get(i.asset)??null)]};break;
      case 'getSignatureStatuses':result={context:{slot:850},value:call.params[0].map(signature=>transactions.has(signature)?{slot:transactions.get(signature).slot,confirmationStatus:'finalized',confirmations:null,err:null}:null)};break;
      case 'getTransaction':result=transactions.get(call.params[0])??null;break;
      case 'getBalance':result={context:{slot:850},value:20000000000};break;
      case 'getLatestBlockhash':result={context:{slot:850},value:block};break;
      case 'getFeeForMessage':result={context:{slot:850},value:10000};break;
      case 'getMinimumBalanceForRentExemption':result=1999999;break;
      case 'simulateTransaction':result={context:{slot:850},value:{err:null,unitsConsumed:99999,accounts:[sequentialAssetAccount(order,prefix)]}};break;
      case 'isBlockhashValid':result={context:{slot:850},value:true};break;
      case 'getBlockHeight':result=1800;break;
      default:assert.fail('Unexpected RPC '+call.method);
    }
    result=structuredClone(result);if(transform)result=transform(call,result,accountReads);
    return Response.json({jsonrpc:'2.0',id:call.id,result});
  };
  let now=Date.now();const values=new Map();
  const storage={get:async k=>structuredClone(values.get(k)??preparations.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),transaction:async fn=>fn(storage)};
  let gate;
  const localGate=async()=>{if(!gate){const {makeBuyerGateway}=await import('../../orders/gateway/worker.mjs');
    gate=new(makeBuyerGateway(f.config(origin)).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
      {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl});}return gate;};
  const fixture={...f,calls,preparations,get fixtureSubmissions(){return fixtureSubmissions;},upstream:async(request,ResponseType=Response)=>{
    const response=await fetchImpl(request.url,{body:await request.text()});
    return new ResponseType(await response.text(),{status:response.status,headers:response.headers});}};
  function observe(value){const checked=inspectSignedDeploymentTransaction(value.response.transactionBase64),index=value.claim.itemIndex;
    transactions.set(checked.signature,{slot:750+index,version:0,transaction:[checked.transactionBase64,'base64'],meta:{err:null}});
    assetAccounts.set(value.claim.asset,sequentialAssetAccount(value.order,index));}
  return{fixture,calls,input,values,readyOrder,observe,expectFixtureSubmission,read:()=>structuredClone(order),set:v=>{order=v;},
    run:()=>checker[signed?'checkSignedOrder':prepared?'checkPreparedOrder':'preflightOrder']({readOrder:()=>structuredClone(order),endpoint,fetchImpl,...input}),
    dispatch:async(route='prepare',body={order:readyOrder})=>{now+=1000;return (await localGate()).fetch(new Request(origin+'/api/buyer/'+route,
      {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce:'a'.repeat(64),...body})}));}};
}

