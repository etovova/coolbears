// Structurally valid full history, disposable offline signatures and intercepted
// HTTP only. Synthetic historical proofs are not live chain evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from '../orders/journal-model.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse,buyerRequestId} from '../orders/signing.mjs';
import {preparationFor} from '../orders/preparation.mjs';
import {createCostQuote,validateCostApproval,checkedBudget} from '../orders/cost-approval.mjs';
import {submissionBinding} from '../orders/submission.mjs';
import {createBuyerPreparationClient} from '../orders/gateway/preparation-client.mjs';
import {createBuyerCheckClient} from '../orders/gateway/client.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {readJson,BUYER_BODY_LIMIT} from '../orders/gateway/http.mjs';
const model=createOrderModel(policy),key=n=>Keypair.fromSeed(createHash('sha256').update('sequential-cost:'+n).digest());
const buyer=key('buyer'),address=n=>key(n).publicKey.toBase58(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const block={blockhash:address('current-block'),lastValidBlockHeight:20000};
function fullHistory(){
  let order=model.createOrder({id:'full-sequential-history',cluster:'devnet',buyer:buyer.publicKey.toBase58(),machine:address('machine'),collection:address('collection'),guard:address('guard'),quantity:50,available:9999,assets:Array.from({length:50},(_,i)=>address('asset-'+i))});
  for(let index=0;index<49;index++)for(let number=1;number<=2;number++){
    const blockhash=address(`block-${index}-${number}`),messageSha256=hash([index,number]);
    order=model.transitionOrder(order,{type:'prepare',revision:order.revision,index,blockhash,lastValidBlockHeight:1000,messageSha256,...(number===2?{retry:true}:{})});
    const signature=base58.deserialize(new Uint8Array([...createHash('sha256').update(`signature-${index}-${number}`).digest(),...createHash('sha256').update(`tail-${index}-${number}`).digest()]))[0];
    order=model.transitionOrder(order,{type:'unknown',revision:order.revision,index,attempt:number});
    order=model.transitionOrder(order,{type:'signature',revision:order.revision,index,attempt:number,signature,messageSha256});
    const proof={kind:number===1?'failed':'verified',cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,asset:order.items[index].asset,blockhash,messageSha256,commitment:'finalized',slot:100+index,signature,accountSlot:200+index,
      ...(number===1?{executionFailed:true,accountAbsent:true}:{account:{program:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',owner:order.buyer,collection:order.collection,name:policy.hiddenName.replace('{index:04d}','0001'),uri:policy.website+'/metadata/hidden/0001.json'}})};
    order=model.transitionOrder(order,{type:'reconcile',revision:order.revision,index,attempt:number,proof});
  }
  return order;
}
function current(order){
  const prepared=prepareAssetClaim(order,preparationFor(order,block,1000).candidate),tx=VersionedTransaction.deserialize(Buffer.from(prepared.claim.transactionBase64,'base64'));
  tx.sign([key('asset-49')]);const request=finalizeAssetRequest(prepared.order,prepared.claim,tx.signatures[1]);
  return {order:prepared.order,claim:prepared.claim,request};
}
function check(input){const {order,claim,request}=input,now=Date.now(),total='203500000';return{
  status:'wallet-check-passed',mode:'closed-devnet-sign-only-check',cluster:'devnet',orderId:order.id,orderRevision:order.revision,orderSha256:hash(order),requestId:buyerRequestId(request),
  itemIndex:49,quantity:50,checkedSlot:1000,checkedAt:now,expiresAt:now+20000,candidate:{...request},networkVerified:true,guardPriceVerified:true,blockhashVerified:true,blockhashProvenanceVerified:true,
  simulationVerified:true,simulationMode:'unsigned',readyToSign:true,readyToSubmit:false,salesOpen:false,
  budget:{complete:true,scope:'next-item-current-template',projectionOnly:true,fullOrderTotalLamports:null,orderItemPriceLamports:order.totalPriceLamports,
    unitPriceLamports:order.unitPriceLamports,nextItemFeeLamports:'10000',nextItemBaseRentLamports:'3480000',protocolChargesLamports:'10000',priorityFeeLamports:'0',nextItemKnownMinimumLamports:total,
    projectedOrderTotalLamports:String(BigInt(total)*50n),completedQuantity:49,remainingQuantity:1,projectedRemainingTotalLamports:total,balanceLamports:'20000000000'}};}
test('item50 cost consent distinguishes remaining projection and cannot reuse altered or old-version consent',()=>{
  const input=current(fullHistory()),report=check(input),quote=createCostQuote(input,report);
  assert.equal(quote.version,2);assert.equal(quote.budget.remainingQuantity,1);assert.equal(quote.budget.completedQuantity,49);
  assert.equal(quote.budget.projectedRemainingTotalLamports,quote.budget.totalLamports);
  const approval={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:quote.issuedAt};assert.deepEqual(validateCostApproval(approval,input),approval);
  for(const mutate of [q=>q.version=1,q=>q.budget.remainingQuantity=50,q=>q.budget.projectedRemainingTotalLamports=q.budget.projectedOrderTotalLamports,q=>q.requestId='0'.repeat(64)]){
    const changed=structuredClone(approval);mutate(changed.quote);assert.throws(()=>validateCostApproval(changed,input));
  }
  const forged=structuredClone(report);forged.budget.remainingQuantity=50;assert.throws(()=>checkedBudget(forged,input.order));
});
test('complete49x2 history fits bounded storage and all three real HTTP transports beyond64KiB',async()=>{
  const order=fullHistory(),input=current(order),report=check(input);report.costQuote=createCostQuote(input,report);
  const seen=[],origin='https://buyer-sequential.example',fetchImpl=async(url,options)=>{
    const bytes=Buffer.byteLength(options.body);seen.push(bytes);assert.ok(bytes>65536&&bytes<BUYER_BODY_LIMIT);
    const body=await readJson(new Request(url,{method:'POST',headers:options.headers,body:options.body}));
    const value=url.endsWith('/prepare')?{status:'prepared',...preparationFor(body.order,block,1000),restored:false,readyToSign:false,readyToSubmit:false,salesOpen:false}:
      url.endsWith('/check')?report:{...submissionBinding(body),cluster:'devnet',status:'unknown',chainVerified:false,transactionsSent:0,networkRequests:0,readyToSubmit:false,salesOpen:false};
    return new Response(JSON.stringify({version:1,nonce:body.nonce,report:value}),{headers:{'content-type':'application/json'}});
  };
  assert.ok(Buffer.byteLength(JSON.stringify(order))<262144&&order.revision<1024);
  assert.equal((await createBuyerPreparationClient({origin,fetchImpl})({order})).candidate.itemIndex,49);
  assert.equal((await createBuyerCheckClient({origin,fetchImpl})(input)).costQuote.version,2);
  const tx=VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64'));tx.sign([buyer]);
  let signedOrder=model.transitionOrder(input.order,{type:'unknown',revision:input.order.revision,index:49,attempt:1});
  const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')},signed=verifyBuyerSigningResponse(signedOrder,input.claim,input.request,response);
  signedOrder=model.transitionOrder(signedOrder,{type:'signature',revision:signedOrder.revision,index:49,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  assert.equal((await createBuyerSubmissionTransport({origin,fetchImpl}).recover({...input,order:signedOrder,response})).status,'unknown');
  assert.equal(seen.length,3);
  await assert.rejects(readJson(new Response(' '.repeat(BUYER_BODY_LIMIT+1),{headers:{'content-type':'application/json'}})),error=>error.code==='BODY_SIZE');
});
