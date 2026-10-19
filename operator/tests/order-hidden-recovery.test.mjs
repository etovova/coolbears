// Discarded deterministic keys and intercepted RPC only. No wallet or chain execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import policySource from '../../metadata/policy.json' with {type:'json'};
import {hiddenBuyerGatewayFixture} from './fixtures/hidden-buyer-gateway.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {makeBuyerGateway} from '../orders/gateway/worker.mjs';
import {validateBuyerResult} from '../orders/submission.mjs';
import {validatePrewalletRecovery,prewalletRecoveryKey} from '../orders/prewallet-recovery.mjs';
import {validateResponseRecovery,responseRecoveryKey} from '../orders/response-recovery.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {prepareAssetClaim,finalizeAssetRequest} from '../orders/signing.mjs';
import {VersionedTransaction} from '@solana/web3.js';
const f=hiddenBuyerGatewayFixture({syntheticOwner:true});
// Isolated node:test worker policy, equivalent to runtime fixture-policy injection.
policySource.owner=f.policy.owner;
const origin='https://hidden-recovery.test',nonce='a'.repeat(64);
function harness(){
  let now=Date.now();const data=new Map(f.preparations);
  const storage={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),transaction:async fn=>fn(storage)};
  const built=makeBuyerGateway(f.config(origin));
  const create=()=>new built.BuyerCheckGate({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(url,init)=>f.upstream(new Request(url,init))});let gate=create();
  return{data,restart:()=>{gate=create();},call:async(route,input)=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,
    {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input})}));}};
}
async function report(response){assert.equal(response.status,200,await response.clone().text());return(await response.json()).report;}

test('hidden finalized recovery reconstructs exact signed mint and accepts canonical indexed account without spending or granting send',async()=>{
  f.setMode('normal');const full=f.signedInput('exact-finalized'),h=harness();f.observeResponse(full);const before=f.calls.length;
  const found=await report(await h.call('recover',full));validateBuyerResult(found,full,{recovery:true});
  assert.equal(found.status,'verified');assert.equal(found.proof.account.name,'CoolBears #1000');assert.equal(found.proof.account.uri,f.policy.website+'/metadata/hidden-indexed/1000.json');
  assert.equal(found.transactionsSent,0);assert.equal(found.readyToSubmit,false);assert.equal(found.salesOpen,false);
  assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getSignatureStatuses','getTransaction','getMultipleAccounts']);
  assert.ok(f.calls.every(c=>c.method!=='sendTransaction'));
  assert.equal((await h.call('send',{...full,costApproval:{}})).status,403);
});

test('hidden missing native result and lost wallet callback recover canonical indexed evidence and restore only the saved outcome',async()=>{
  for(const route of ['recover-prewallet','recover-response']){
    f.setMode('normal');const full=f.signedInput(route),input=route==='recover-prewallet'?{...f.input(route),request:null}:missingResponse(full),h=harness();f.observeResponse(full);
    const found=await report(await h.call(route,input));
    if(route==='recover-prewallet')validatePrewalletRecovery(found,input);else validateResponseRecovery(found,input);
    assert.equal(found.result.status,'verified');assert.equal(found.result.proof.account.name,'CoolBears #1000');assert.equal(found.retryAuthorized,false);assert.equal(found.readyToSubmit,false);
    const key=route==='recover-prewallet'?prewalletRecoveryKey(input.order):responseRecoveryKey(input.order);assert.ok(h.data.has(key));
    const before=f.calls.length;h.restart();const restored=await report(await h.call(route,input));assert.equal(restored.restored,true);assert.equal(f.calls.length,before);
    const changed={...input,order:{...input.order,hiddenCommitmentSha256:'b'.repeat(64)}};assert.equal((await h.call(route,changed)).status,400);assert.equal(f.calls.length,before);
    assert.equal((await h.call('send',{...full,costApproval:{}})).status,403);
  }
});

test('hidden failure preserves exact buyer-paid fee proof; durable restore never repeats the failed transaction',async()=>{
  f.setMode('failure-finalized');const full=f.signedInput('failed-fee'),h=harness();f.observeResponse(full);
  const found=await report(await h.call('recover',full));validateBuyerResult(found,full,{recovery:true});
  assert.equal(found.status,'failed');assert.equal(found.evidence.feeLamports,'10000');assert.equal(found.evidence.payerDebitLamports,'10000');
  assert.equal(found.retryAuthorized,false);assert.ok(h.data.has(failureKey(full.order)));
  const before=f.calls.length;h.restart();const restored=await report(await h.call('recover',full));assert.equal(restored.restored,true);assert.equal(f.calls.length,before);
  assert.ok(f.calls.every(c=>c.method!=='sendTransaction'));
});

test('hidden receipt recovery rejects old placeholder paths, padded IDs, altered names, nonfinalized receipts, absent assets and mismatched transaction bytes',async()=>{
  for(const mode of ['legacy-uri','padded-uri','wrong-name','receipt-pending','absent-asset','wrong-receipt']){
    f.setMode(mode);const full=f.signedInput('bad-'+mode),h=harness();f.observeResponse(full);
    const found=await report(await h.call('recover',full));assert.equal(found.status,'unknown',mode);assert.equal(found.chainVerified,false);assert.equal(found.proof,undefined);assert.equal(found.transactionsSent,0);
  }
});

test('hidden next item requires authentic finalized prefix and quotes the fresh machine index without changing the completed asset',async()=>{
  f.setRedeemed(999);f.setMode('normal');const full=f.signedInput('sequential',2),h=harness();f.observeResponse(full);
  const found=await report(await h.call('recover',full));
  const order=f.model.transitionOrder(full.order,{type:'reconcile',revision:full.order.revision,index:0,attempt:1,proof:found.proof});
  const first=JSON.stringify(order.items[0]);f.setRedeemed(1000);
  const prepared=await report(await h.call('prepare',{order}));assert.equal(prepared.candidate.itemIndex,1);
  const claimed=prepareAssetClaim(order,prepared.candidate),tx=VersionedTransaction.deserialize(Buffer.from(claimed.claim.transactionBase64,'base64'));
  tx.sign([f.key('asset-sequential-1')]);const request=finalizeAssetRequest(claimed.order,claimed.claim,tx.signatures[1]);
  const input={order:claimed.order,claim:claimed.claim,request};
  const checked=await report(await h.call('check',input));assert.equal(checked.status,'wallet-check-passed');assert.equal(checked.itemIndex,1);
  assert.equal(checked.budget.completedQuantity,1);assert.equal(checked.budget.remainingQuantity,1);
  assert.equal(checked.budget.unitPriceLamports,'200000000');assert.equal(checked.budget.baseAssetBytes,150);
  assert.equal(JSON.stringify(input.order.items[0]),first);assert.equal(checked.transactionsSent,0);
  const forged=structuredClone(input);forged.order.items[0].attempts.at(-1).proof.account.name='CoolBears #1';
  forged.order.items[0].attempts.at(-1).proof.account.uri=f.policy.website+'/metadata/hidden-indexed/1.json';
  const blocked=await h.call('check',forged),body=await blocked.json();assert.equal(blocked.status,409);
  assert.equal(body.report.code,'PRIOR_ASSET_CHANGED');assert.equal(body.report.readyToSign,false);
  assert.equal(JSON.stringify(input.order.items[0]),first);
});
