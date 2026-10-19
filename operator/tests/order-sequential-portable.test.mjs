// Deterministic offline signatures and normalized synthetic proofs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from '../orders/journal-model.mjs';
import {preparationFor} from '../orders/preparation.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse,verifyBuyerEvidence,buyerRequestId} from '../orders/signing.mjs';
import {validateBuyerSubmission,submissionBinding,validateBuyerResult,signedBytesId} from '../orders/submission.mjs';
import {validatePrewalletInput,prewalletSubmission,prewalletRecoveryReport,prewalletRecoveryRecord,prewalletFailureSource,prewalletRecoveryKey} from '../orders/prewallet-recovery.mjs';
import {validateMissingBuyerResponse,recoveredSubmission,responseRecoveryKey} from '../orders/response-recovery.mjs';
import {prewalletExpiryReport,prewalletExpiryRecord,prewalletExpiryKey} from '../orders/prewallet-expiry.mjs';
import {responseExpiryReport,responseExpiryRecord,responseExpiryKey} from '../orders/response-expiry.mjs';
import {expiryRecord,expiryKey} from '../orders/expiry-review.mjs';
import {failureRecord,validateHistoricalFailure,failureKey} from '../orders/failure-record.mjs';
import {replacementFor,replacementCandidate,replacementReport,validateReplacementClaim,replacementKey} from '../orders/replacement.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
const model=createOrderModel(policy),key=label=>Keypair.fromSeed(createHash('sha256').update('sequential-portable:'+label).digest());
const buyer=key('buyer'),assets=[0,1,2].map(n=>key('asset-'+n));
const block=n=>({blockhash:key('block-'+n).publicKey.toBase58(),lastValidBlockHeight:1000+n*1000});
function fresh(id){return model.createOrder({id,cluster:'devnet',buyer:buyer.publicKey.toBase58(),machine:key('machine').publicKey.toBase58(),collection:key('collection').publicKey.toBase58(),guard:key('guard').publicKey.toBase58(),quantity:3,available:9999,assets:assets.map(k=>k.publicKey.toBase58())});}
function native(order,n=1){
  const prepared=prepareAssetClaim(order,preparationFor(order,block(n),600).candidate),claim=prepared.claim;
  const tx=VersionedTransaction.deserialize(Buffer.from(claim.transactionBase64,'base64'));
  const request=finalizeAssetRequest(prepared.order,claim,ed25519.sign(tx.message.serialize(),assets[claim.itemIndex].secretKey.slice(0,32)));
  return{order:prepared.order,claim,request};
}
function missing(input){const order=model.transitionOrder(input.order,{type:'unknown',revision:input.order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt});return{...input,order,walletClaim:{version:1,claimId:'c'.repeat(64),requestId:buyerRequestId(input.request),orderRevision:order.revision}};}
function response(input){const tx=VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64'));tx.sign([buyer]);return{transactionBase64:Buffer.from(tx.serialize()).toString('base64')};}
function signed(input){const {walletClaim,...value}=missing(input),answer=response(value),checked=verifyBuyerSigningResponse(value.order,value.claim,value.request,answer);
  return{...value,order:model.transitionOrder(value.order,{type:'signature',revision:value.order.revision,index:value.claim.itemIndex,attempt:value.claim.attempt,signature:checked.signature,messageSha256:checked.messageSha256}),response:answer};}
function proof(input,kind){const {order,claim}=input,signature=order.items[claim.itemIndex].attempts[claim.attempt-1].signature;
  return{kind,cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,asset:claim.asset,blockhash:claim.blockhash,messageSha256:claim.messageSha256,commitment:'finalized',slot:800,signature,
    ...(kind==='verified'?{accountSlot:900,account:{program:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',owner:order.buyer,collection:order.collection,name:policy.hiddenName.replace('{index:04d}','0001'),uri:policy.website+'/metadata/hidden/0001.json'}}:
      kind==='failed'?{executionFailed:true,accountAbsent:true,accountSlot:900}:{blockhashValid:false,blockHeight:claim.lastValidBlockHeight+100,signatureAbsent:true,statusSlot:900,accountAbsent:true,accountSlot:900,addressHistoryEmpty:true})};}
function close(input,p){return{...input,order:model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt,proof:p})};}
function later(id){const first=signed(native(fresh(id))),done=close(first,proof(first,'verified'));let order=done.order;
  order=model.transitionOrder(order,{type:'pause',revision:order.revision});order=model.transitionOrder(order,{type:'resume',revision:order.revision});
  return{first,done,current:native(order)};
}
function terminalReport(input,kind){return{...submissionBinding(input),cluster:'devnet',status:kind,chainVerified:true,transactionsSent:0,networkRequests:0,retryAuthorized:false,restored:false,readyToSubmit:false,salesOpen:false,proof:proof(input,kind),
  ...(kind==='failed'?{evidence:{slot:800,statusSlot:900,errorSha256:'f'.repeat(64),feeLamports:'10000',payerDebitLamports:'10000',payerPreBalanceLamports:'20000000000',payerPostBalanceLamports:'19999990000'}}:{})};}
function expiryEvidence(input,unsigned=false){return{blockhash:input.claim.blockhash,anchorSlot:600,slot:800,blockHeight:input.claim.lastValidBlockHeight+100,lastValidBlockHeight:input.claim.lastValidBlockHeight,historyPages:1,...(unsigned?{historyTransactions:1}:{}),historySha256:'e'.repeat(64)};}
function retired(id,version){const {current}=later(id);let input,prior,prewallet;
  if([1,2].includes(version)){
    input=signed(current);const kind=version===1?'expired':'failed',report=terminalReport(input,kind);
    if(version===1)report.evidence=expiryEvidence(input);
    prior=version===1?expiryRecord(input,report):failureRecord(input,report);input=close(input,report.proof);
  }else if(version===3){
    const answer=response(current),full=prewalletSubmission(current,answer),result=terminalReport(full,'failed');
    const report=prewalletRecoveryReport(current,{response:answer,result}),record=prewalletRecoveryRecord(current,report);
    const closed=close(current,result.proof),source=prewalletFailureSource(closed.order,current.claim,record);
    input=source.input;prior=source.failureRecord;prewallet=source.prewalletRecord;
  }else{
    input=version===4?{...current,request:null}:missing(current);
    const p=proof(input,'expired'),e=expiryEvidence(input,true),report=version===4?prewalletExpiryReport(input,{proof:p,evidence:e}):responseExpiryReport(input,{proof:p,evidence:e});
    prior=version===4?prewalletExpiryRecord(input,report):responseExpiryRecord(input,report);input=close(input,p);
  }
  return{input,prior,prewallet};
}
test('second-item signed and recovery projections bind item2 without mutating verified item1',()=>{
  const {first,current}=later('sequential-projections'),prefix=structuredClone(current.order.items[0]),full=signed(current);
  assert.equal(validateBuyerSubmission(full).itemIndex,1);
  const report=terminalReport(full,'verified');assert.equal(validateBuyerResult(report,full,{recovery:true}).proof.asset,current.claim.asset);
  assert.deepEqual(prewalletSubmission(current,response(current)),full);
  assert.deepEqual(recoveredSubmission(missing(current),response(current)).input,full);
  assert.deepEqual(full.order.items[0],prefix);assert.equal(full.order.items[2].attempts.length,0);
  assert.equal(verifyBuyerEvidence(full.order,first.claim,first.request,first.response).itemIndex,0);
  assert.throws(()=>validateBuyerSubmission({...first,order:full.order}));
  for(const validator of [validateBuyerSubmission,validatePrewalletInput,validateMissingBuyerResponse]){
    const source=validator===validateBuyerSubmission?full:validator===validatePrewalletInput?current:missing(current);
    const swapped=structuredClone(source);swapped.claim.itemIndex=0;assert.throws(()=>validator(swapped));
    const skipped=structuredClone(source);skipped.order.items[0].attempts=[];assert.throws(()=>validator(skipped));
    const progressed=structuredClone(source);progressed.order.items[2].attempts=structuredClone(progressed.order.items[1].attempts);assert.throws(()=>validator(progressed));
  }
});
for(const version of [1,2,3,4,5])test(`second-item replacement v${version} preserves original revision, prefix, proof and one retry`,()=>{
  const {input,prior,prewallet}=retired('sequential-replace-'+version,version),before=structuredClone(input),fee=prior.proof.kind==='failed'?'10000':undefined;
  const record=replacementFor(input,prior,block(2),1000,fee,prewallet);
  assert.equal(record.version,version);assert.deepEqual(record.originalClaim,input.claim);assert.ok(record.originalClaim.orderRevision>1);
  if([1,2].includes(version))assert.deepEqual(record.originalRequest,input.request);
  const report=replacementReport(input,record),prepared=prepareAssetClaim(input.order,report.candidate);
  assert.equal(prepared.claim.itemIndex,1);assert.equal(prepared.claim.attempt,2);assert.deepEqual(prepared.order.items[0],input.order.items[0]);
  assert.deepEqual(prepared.order.items[1].attempts[0],input.order.items[1].attempts[0]);assert.equal(prepared.order.items[2].attempts.length,0);
  assert.deepEqual(validateReplacementClaim(prepared.order,prepared.claim,record),record);assert.deepEqual(input,before);
  const tx=VersionedTransaction.deserialize(Buffer.from(prepared.claim.transactionBase64,'base64'));
  const request=finalizeAssetRequest(prepared.order,prepared.claim,ed25519.sign(tx.message.serialize(),assets[1].secretKey.slice(0,32)));
  const second=signed({order:prepared.order,claim:prepared.claim,request}),verified=close(second,proof(second,'verified')),third=native(verified.order,3);
  assert.deepEqual(validateReplacementClaim(third.order,prepared.claim,record),record);
  assert.equal(verifyBuyerEvidence(third.order,second.claim,second.request,second.response).itemIndex,1);
  if(version===2)assert.deepEqual(validateHistoricalFailure({...input,order:third.order},prior),prior);
  assert.throws(()=>replacementFor(close(second,proof(second,'expired')),prior,block(3),1500));
  for(const edit of [r=>delete r.originalClaim,r=>r.originalClaim.itemIndex=0,r=>r.originalClaim.orderRevision++,r=>r.originalClaim.asset=assets[0].publicKey.toBase58(),r=>r.prior.proof.asset=assets[0].publicKey.toBase58()]){
    const changed=structuredClone(record);edit(changed);assert.throws(()=>replacementCandidate(input.order,changed));
  }
});
test('later-item original revision cannot be changed even with a recomputed record digest',()=>{
  for(const version of [1,2,3,4,5]){
    const {input,prior,prewallet}=retired('sequential-retained-revision-'+version,version),fee=prior.proof.kind==='failed'?'10000':undefined;
    const record=replacementFor(input,prior,block(2),1000,fee,prewallet);record.originalClaim.orderRevision--;
    const {replacementId,...fields}=record;record.replacementId=signedBytesId(JSON.stringify(fields));
    assert.throws(()=>replacementCandidate(input.order,record));
  }
});
test('every durable key isolates item and attempt while preserving item0 keys',()=>{
  const {current}=later('sequential-keys'),order=current.order;
  for(const keyFor of [anchorKey,expiryKey,failureKey,prewalletRecoveryKey,responseRecoveryKey,prewalletExpiryKey,responseExpiryKey]){
    assert.equal(keyFor(order),keyFor(order,1,0));assert.notEqual(keyFor(order,1,0),keyFor(order,1,1));assert.notEqual(keyFor(order,1,1),keyFor(order,2,1));
  }
  assert.equal(replacementKey(order),replacementKey(order,0));assert.notEqual(replacementKey(order,0),replacementKey(order,1));
});
