// Actual local workerd/SQLite; every key, signature, history row and RPC is synthetic.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {none} from '@metaplex-foundation/umi';
import {Key,MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import {getAssetV1AccountDataSerializer} from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerStorageRuntime} from './fixtures/buyer-storage-runtime.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {prepareAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse,buyerRequestId} from '../orders/signing.mjs';
import {prewalletExpiryReplacementSource} from '../orders/prewallet-expiry-replacement.mjs';
import {responseExpiryReplacementSource} from '../orders/response-expiry-replacement.mjs';
import {prewalletExpiryKey} from '../orders/prewallet-expiry.mjs';
import {responseExpiryKey} from '../orders/response-expiry.mjs';
import {replacementKey,validateReplacementResult} from '../orders/replacement.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {validateCostApproval} from '../orders/cost-approval.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const upstream=f.upstream,accounts=new Map();let floor=700;
// Lift the fixture's finalized view beyond item1's receipt; populate only assets
// whose exact successful signed transaction was registered by this test.
f.upstream=async(request,ResponseType=Response)=>{
  const call=await request.clone().json(),response=await upstream(request,ResponseType),body=await response.json();
  if(call.method==='getMultipleAccounts'&&call.params[0].length>1){
    body.result.value=body.result.value.map((raw,index)=>index<6?raw:accounts.get(call.params[0][index])??null);
  }
  if(body.result?.context){
    const options=call.params.findLast(value=>value&&typeof value==='object'&&!Array.isArray(value));
    body.result.context.slot=Math.max(body.result.context.slot,options?.minContextSlot??0,floor);
    floor=Math.max(floor,body.result.context.slot);
  }
  return new ResponseType(JSON.stringify(body),{headers:{'content-type':'application/json'}});
};
const history=prewalletExpiryFixture(f),origin='https://buyer-sequential-replacement-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-sequential-replacement-runtime-'));
const runtime=await buyerStorageRuntime({fixture:f,origin,persist,allowSubmission:true}),cases=[];
const call=async(route,input,extra={})=>{await new Promise(resolve=>setTimeout(resolve,250));return runtime.dispatch(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce:'a'.repeat(64),...input,...extra})});};
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const approve=quote=>({version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()});
function sign(input){let order=f.model.transitionOrder(input.order,{type:'unknown',revision:input.order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt});
  const tx=VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64'));tx.sign([f.owner]);const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  const signed=verifyBuyerSigningResponse(order,input.claim,input.request,response);order=f.model.transitionOrder(order,{type:'signature',revision:order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt,signature:signed.signature,messageSha256:signed.messageSha256});return{...input,order,response};}
function partial(order,candidate){const prepared=prepareAssetClaim(order,candidate),claim=prepared.claim,tx=VersionedTransaction.deserialize(Buffer.from(claim.transactionBase64,'base64'));
  const asset=f.key('asset-'+order.id+'-'+claim.itemIndex),request=finalizeAssetRequest(prepared.order,claim,ed25519.sign(tx.message.serialize(),asset.secretKey.slice(0,32)));return{order:prepared.order,claim,request};}
const close=(input,proof)=>({...input,order:f.model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:input.claim.itemIndex,attempt:input.claim.attempt,proof})});
async function expired(id,version){
  history.set(false);history.history();history.rewrite(undefined);f.setGeneration(1);floor=700;
  const first=sign(f.input(id,2));f.receipt(first.response.transactionBase64);
  const verified=await report(await call('recover',first));assert.equal(verified.status,'verified');
  const done=close(first,verified.proof),p=verified.proof;
  const data=getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:p.buyer,updateAuthority:{__kind:'Collection',fields:[p.collection]},seq:none(),name:p.account.name,uri:p.account.uri});
  accounts.set(p.asset,{owner:MPL_CORE_PROGRAM_ID,executable:false,lamports:2000000,data:[Buffer.from(data).toString('base64'),'base64']});
  let order=f.model.transitionOrder(done.order,{type:'pause',revision:done.order.revision});order=f.model.transitionOrder(order,{type:'resume',revision:order.revision});
  const prepared=await report(await call('prepare',{order})),native=partial(order,prepared.candidate);
  assert.equal(native.claim.itemIndex,1);assert.ok(native.claim.orderRevision>1);
  const approval=approve((await report(await call('check',native))).costQuote);
  let input=version===4?{...native,request:null}:{...native,order:f.model.transitionOrder(native.order,{type:'unknown',revision:native.order.revision,index:1,attempt:1})};
  if(version===5)input.walletClaim={version:2,claimId:'c'.repeat(64),requestId:buyerRequestId(native.request),orderRevision:input.order.revision,costApproval:approval};
  const anchor=prepared.anchor.sourceSlot;
  history.set();history.rewrite((call,body)=>{if(call.method==='getBlock'&&call.params[0]===anchor)body.result={blockhash:native.claim.blockhash,blockHeight:1800,parentSlot:anchor-1};});
  const route=version===4?'review-prewallet-expiry':'review-response-expiry',ended=await report(await call(route,input,{authorizeExpiryReview:true}));
  assert.equal(ended.status,version===4?'prewallet-expired':'response-expired');
  const retired=close(input,ended.proof),source=version===4?prewalletExpiryReplacementSource(retired.order,input.claim,ended,input.request):responseExpiryReplacementSource(retired.order,input.claim,ended,input.request,input.walletClaim);
  history.set(false);history.rewrite(undefined);f.setGeneration(2);return{first,native,input,source,approval,ended};
}
try{
  await runtime.start();
  for(const version of [4,5]){
    const value=await expired('runtime-sequential-v'+version,version),route=version===4?'replace-prewallet-expiry':'replace-response-expiry';
    const replace=()=>call(route,value.source.input,{authorizeReplacement:true});
    const firstProof=structuredClone(value.source.input.order.items[0].attempts[0].proof),replacement=await report(await replace());
    validateReplacementResult(replacement,value.source.input);assert.equal(replacement.record.version,version);
    assert.deepEqual(replacement.record.originalClaim,value.input.claim);assert.equal(replacement.candidate.itemIndex,1);
    assert.deepEqual(value.source.input.order.items[0].attempts[0].proof,firstProof);
    const retiredKey=(version===4?prewalletExpiryKey:responseExpiryKey)(value.input.order,1,1),replaceKey=replacementKey(value.input.order,1);
    const saved=(await runtime.storage('get',replaceKey)).value,retained=(await runtime.storage('get',retiredKey)).value;
    assert.deepEqual(retained,value.source.expiryRecord);assert.equal((await runtime.storage('get',replacementKey(value.input.order))).present,false);
    assert.equal((await runtime.storage('get',anchorKey(value.input.order,1,1))).present,true);
    cases.push(`item2 v${version} retains original claim revision, verified item1 and its independent finalized expiry/replacement SQLite records`);

    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});let before=f.calls.length;
    const restored=await report(await replace());assert.equal(restored.restored,true);assert.deepEqual(restored.record,saved);assert.equal(f.calls.length,before);
    const retry=partial(value.source.input.order,restored.candidate);
    await runtime.storage('delete',retiredKey);assert.equal((await call('check',retry)).status,409);assert.equal((await replace()).status,409);
    await runtime.storage('put',retiredKey,retained);assert.equal(f.calls.length,before);
    const corrupted=structuredClone(saved);corrupted.originalClaim.orderRevision++;
    await runtime.storage('put',replaceKey,corrupted);assert.equal((await call('check',retry)).status,409);assert.equal((await replace()).status,409);
    await runtime.storage('put',replaceKey,saved);assert.equal(f.calls.length,before);
    cases.push(`item2 v${version} restores after restart and credential rotation without RPC; missing retirement or changed original claim denies cached grant and second check`);

    await runtime.stop();await runtime.start();const secondSigned=sign(retry);before=f.calls.length;
    assert.equal((await call('send',secondSigned,{costApproval:value.approval})).status,409);assert.equal(f.calls.length,before);
    const fresh=approve((await report(await call('check',retry))).costQuote);validateCostApproval(fresh,secondSigned,{now:Date.now()});
    assert.notEqual(fresh.quote.requestId,value.approval.quote.requestId);assert.equal(fresh.quote.version,2);assert.equal(fresh.quote.budget.completedQuantity,1);assert.equal(fresh.quote.budget.remainingQuantity,1);
    assert.deepEqual(secondSigned.order.items[0].attempts[0].proof,firstProof);assert.equal(secondSigned.order.items[1].attempts.length,2);
    assert.deepEqual(secondSigned.order.items[1].attempts[0].proof,value.ended.proof);
    const oldReview=await call(version===4?'review-prewallet-expiry':'review-response-expiry',value.input,{authorizeExpiryReview:true});
    if(version===4){const old=await report(oldReview);assert.equal(old.restored,true);assert.deepEqual(old.proof,value.ended.proof);}
    else assert.equal(oldReview.status,409);
    cases.push(`item2 v${version} needs a fresh peritem cost quote for second bytes and preserves both item1 proof and retired item2 attempt without sending`);
    let second=version===4?{...retry,request:null}:{...retry,order:f.model.transitionOrder(retry.order,{type:'unknown',revision:retry.order.revision,index:1,attempt:2})};
    if(version===5)second.walletClaim={version:2,claimId:'d'.repeat(64),requestId:buyerRequestId(retry.request),orderRevision:second.order.revision,costApproval:fresh};
    history.history([1550,1199]);history.set();
    const secondRoute=version===4?'review-prewallet-expiry':'review-response-expiry',secondEnded=await report(await call(secondRoute,second,{authorizeExpiryReview:true}));
    assert.equal(secondEnded.evidence.anchorSlot,1200);assert.equal(secondEnded.proof.signature,null);
    assert.deepEqual((await runtime.storage('get',retiredKey)).value,retained);
    assert.equal((await runtime.storage('get',(version===4?prewalletExpiryKey:responseExpiryKey)(second.order,2,1))).present,true);
    await runtime.stop();await runtime.start({BUYER_HELIUS_API_KEY:'rotated-secret-42'});before=f.calls.length;
    assert.equal((await report(await call(secondRoute,second,{authorizeExpiryReview:true}))).restored,true);
    assert.equal((await call(route,close(second,secondEnded.proof),{authorizeReplacement:true})).status,400);
    assert.equal((await call('send',secondSigned,{costApproval:fresh})).status,409);assert.equal(f.calls.length,before);
    cases.push(`item2 v${version} second retirement uses its own anchor and tombstone; SQLite restart preserves both attempts and denies a third attempt or old send`);
    await runtime.stop();await runtime.start();

  }
  assert.deepEqual(runtime.errors,[]);assert.equal((await runtime.ids()).length,1);assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:f.calls.length,fixtureSubmissions:0,transactionsSent:0,liveRpc:false},null,2));
}finally{await runtime.stop();await rm(persist,{recursive:true,force:true});}
