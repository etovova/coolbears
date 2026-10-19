// Closed Devnet protocol: disposable signatures, intercepted RPC, no live wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {responseRecoveryKey} from '../orders/response-recovery.mjs';
import {prewalletRecoveryKey} from '../orders/prewallet-recovery.mjs';
import {prewalletExpiryKey} from '../orders/prewallet-expiry.mjs';
import {responseExpiryKey} from '../orders/response-expiry.mjs';
import {responseExpiryReplacementSource} from '../orders/response-expiry-replacement.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {replacementKey,validateReplacementClaim,validateReplacementResult} from '../orders/replacement.mjs';
import {signedBytesId} from '../orders/submission.mjs';
import {costQuoteKey} from '../orders/cost-approval.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const history=prewalletExpiryFixture(f),{makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://response-expiry-replacement.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const pre=id=>f.input(id);
const sendKey=order=>anchorKey(order).replace('buyer-blockhash:v1:','buyer-send:v1:');
const consent=checked=>({version:1,quote:checked.costQuote,maxTotalLamports:checked.costQuote.budget.totalLamports,approvedAt:Date.now()});
function harness(){
  history.set(false);history.history();history.rewrite(undefined);f.setGeneration(1);
  const values=new Map();let now=Date.now(),fault,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-replacement:')){if(fault==='write')throw Error('private storage detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){const before=structuredClone(values);let result;
    try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of before)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-replacement:')&&!before.has(k))){fault=null;throw Error('lost commit acknowledgment');}return result;}};
  const create=(secret='fixture-secret-42')=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:secret},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const c=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const b=await r.json();rewrite(c,b);return Response.json(b);}});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  return{values,call,replace:input=>call('replace-response-expiry',input,{authorizeReplacement:true}),
    async expire(id,approval=false){const full=f.signedInput(id),order=f.model.createOrder({...full.order,available:9999,assets:full.order.items.map(i=>i.asset)});
      await report(await call('prepare',{order}));
      let cost;if(approval){const quote=(await report(await call('check',f.input(id)))).costQuote;
        cost={version:1,quote,maxTotalLamports:quote.budget.totalLamports,approvedAt:Date.now()};}
      const input=missingResponse(full,cost);history.set();
      const retired=await report(await call('review-response-expiry',input,{authorizeExpiryReview:true}));
      const closed=f.model.transitionOrder(input.order,{type:'reconcile',revision:input.order.revision,index:0,attempt:1,proof:retired.proof});
      history.set(false);f.setGeneration(2);return{input,retired,source:responseExpiryReplacementSource(closed,input.claim,retired,input.request,input.walletClaim)};
    },restart:secret=>{gate=create(secret);},fault:v=>fault=v,rewrite:v=>rewrite=v,advance:()=>now+=46000};
}
test('missing-response expiry replacement preserves the actual signature-free proof; second claim needs a fresh quote and never reopens the old attempt',async()=>{
  for(const hasApproval of [false,true]){
    const h=harness(),{input,source}=await h.expire('response-replacement-'+hasApproval,hasApproval),saved=structuredClone(h.values),before=f.calls.length;
    const next=await report(await h.replace(source.input));validateReplacementResult(next,source.input);
    assert.equal(next.record.version,5);assert.deepEqual(next.record.prior,saved.get(responseExpiryKey(input.order)));
    assert.equal(next.record.prior.proof.signature,null);assert.equal(next.previousSignature,null);
    for(const k of ['acknowledgedFeeLamports','prewallet'])assert.equal(Object.hasOwn(next.record,k),false);
    assert.deepEqual(next.record.responseExpiry,{request:input.request,walletClaim:input.walletClaim});
    for(const k of ['previousRequestId','previousTransactionSha256','response'])assert.equal(Object.hasOwn(next,k),false);
    assert.equal(next.candidate.orderRevision,3);assert.notEqual(next.candidate.blockhash,input.claim.blockhash);
    assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getMultipleAccounts','getLatestBlockhash','getBlockHeight']);
    for(const [k,v]of saved)if(k!== 'buyer-check-budget:v1')assert.deepEqual(h.values.get(k),v);
    for(const k of [expiryKey(input.order),failureKey(input.order),prewalletExpiryKey(input.order),prewalletRecoveryKey(input.order),responseRecoveryKey(input.order),sendKey(input.order)])assert.equal(h.values.has(k),false);
    h.restart('rotated-secret-42');const count=f.calls.length;
    const restored=await report(await h.replace(source.input));assert.equal(restored.restored,true);assert.deepEqual(restored.record,next.record);
    const oldFull=f.signedInput(input.order.id);
    for(const [route,value,extra]of [['check',pre(input.order.id),{}],['send',oldFull,{costApproval:{}}],['recover-response',input,{}],['recover',oldFull,{}],['review-expiry',oldFull,{authorizeExpiryReview:true}]])assert.equal((await h.call(route,value,extra)).status,409);
    assert.equal(f.calls.length,count);h.restart();
    const partial=replacementPartial(f,source.input,next);assert.equal(partial.claim.orderRevision,4);validateReplacementClaim(partial.order,partial.claim,next.record);
    const checked=await report(await h.call('check',partial)),second=signReplacement(f,partial),approval=consent(checked);
    const noConsent=f.calls.length;assert.equal((await h.call('send',second,{costApproval:{}})).status,409);assert.equal(f.calls.length,noConsent);
    assert.equal((await report(await h.call('send',second,{costApproval:approval}))).status,'accepted');
    h.restart();assert.equal((await h.call('send',second,{costApproval:approval})).status,409);
    const recovered=await report(await h.call('recover',second));assert.equal(recovered.status,'verified');
    assert.equal((await h.replace(closeAttempt(f,second,recovered))).status,400);
    assert.deepEqual(h.values.get(responseExpiryKey(input.order)),next.record.prior);
    assert.equal(f.calls.slice(before).filter(c=>c.method==='sendTransaction').length,1);
  }
});
test('explicit action, exact input and retained missing-response expiry are required before replacement RPC',async()=>{
  const h=harness(),{input,source}=await h.expire('response-replacement-required'),count=f.calls.length;
  assert.equal((await h.call('replace-response-expiry',source.input)).status,400);
  assert.equal((await h.replace(input)).status,400);
  for(const extra of [{response:{}},{acknowledgedFeeLamports:'0'},{authorizeReplacement:false}])
    assert.equal((await h.call('replace-response-expiry',source.input,{authorizeReplacement:true,...extra})).status,400);
  const key=responseExpiryKey(input.order),prior=structuredClone(h.values.get(key));h.values.delete(key);
  assert.equal((await h.replace(source.input)).status,409);h.values.set(key,prior);
  for(const edit of [v=>v.claimSha256='0'.repeat(64),v=>v.identity.walletClaimSha256='0'.repeat(64),v=>v.proof.signature='invented',v=>v.evidence.historyTransactions=0,v=>v.evidence.blockhash=f.key('foreign').publicKey.toBase58()]){
    const bad=structuredClone(prior);edit(bad);h.values.set(key,bad);assert.equal((await h.replace(source.input)).status,409);
  }
  h.values.set(key,prior);
  const changed=structuredClone(source.input);changed.walletClaim.claimId='d'.repeat(64);assert.equal((await h.replace(changed)).status,409);
  const {walletClaim,...legacy}=source.input;
  assert.equal((await h.call('replace-prewallet-expiry',legacy,{authorizeReplacement:true})).status,409);
  assert.equal(f.calls.length,count);
});
test('conflicting history, deleted proof and corrupted replacement block both cached grant and second claim',async()=>{
  const h=harness(),{input,source}=await h.expire('response-replacement-conflict'),next=await report(await h.replace(source.input)),partial=replacementPartial(f,source.input,next);
  const key=responseExpiryKey(input.order),prior=structuredClone(h.values.get(key)),count=f.calls.length;
  for(const k of [expiryKey(input.order),failureKey(input.order),prewalletExpiryKey(input.order),prewalletRecoveryKey(input.order),responseRecoveryKey(input.order),sendKey(input.order)]){
    h.values.set(k,{});assert.equal((await h.replace(source.input)).status,409,k);assert.equal((await h.call('check',partial)).status,409,k);h.values.delete(k);
  }
  h.values.delete(key);assert.equal((await h.replace(source.input)).status,409);assert.equal((await h.call('check',partial)).status,409);h.values.set(key,prior);
  const altered=structuredClone(prior);altered.claimSha256='0'.repeat(64);h.values.set(key,altered);
  assert.equal((await h.replace(source.input)).status,409);assert.equal((await h.call('check',partial)).status,409);h.values.set(key,prior);
  for(const edit of [v=>v.anchor.lastValidBlockHeight++,v=>v.prior.proof.blockHeight++,v=>v.version=1,v=>v.acknowledgedFeeLamports='0']){
    const bad=structuredClone(next.record);edit(bad);h.values.set(replacementKey(input.order),bad);
    assert.equal((await h.replace(source.input)).status,409);assert.equal((await h.call('check',partial)).status,409);
  }
  const downgraded=structuredClone(next.record);downgraded.version=1;
  downgraded.replacementId=signedBytesId(JSON.stringify({version:downgraded.version,kind:downgraded.kind,prior:downgraded.prior,anchor:downgraded.anchor,transactionBase64:downgraded.transactionBase64}));
  h.values.set(replacementKey(input.order),downgraded);
  assert.equal((await h.replace(source.input)).status,409);assert.equal((await h.call('check',partial)).status,409);
  assert.equal(f.calls.length,count);
});
test('pause refuses preparation; resume restores one unchanged record with the current order revision',async()=>{
  const h=harness(),{source}=await h.expire('response-replacement-pause'),count=f.calls.length;
  let paused={...source.input,order:f.model.transitionOrder(source.input.order,{type:'pause',revision:3})};
  assert.equal((await h.replace(paused)).status,400);assert.equal(f.calls.length,count);
  const next=await report(await h.replace(source.input)),before=f.calls.length;
  assert.equal((await h.replace(paused)).status,400);
  const resumed={...paused,order:f.model.transitionOrder(paused.order,{type:'resume',revision:4})};
  const restored=await report(await h.replace(resumed));assert.equal(restored.restored,true);assert.deepEqual(restored.record,next.record);
  assert.equal(restored.candidate.orderRevision,5);assert.equal(f.calls.length,before);
});
test('reappearing asset, stale contexts, reused hash and insufficient lifetime cannot create the second claim',async()=>{
  const edits=[
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.value[0]={lamports:1};},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=949;},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.context.slot=1099;},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.blockhash=f.key('hash').publicKey.toBase58();},
    (c,b)=>{if(c.method==='getLatestBlockhash')b.result.value.lastValidBlockHeight=2180;},
    (c,b)=>{if(c.method==='getBlockHeight')b.result=2550;},
    (c,b)=>{if(c.method==='getGenesisHash')b.result='wrong-genesis';}
  ];
  for(const [n,edit]of edits.entries()){
    const h=harness(),{input,source}=await h.expire('response-replacement-rpc-'+n),prior=structuredClone(h.values.get(responseExpiryKey(input.order)));
    h.rewrite(edit);assert.notEqual((await h.replace(source.input)).status,200,String(n));
    assert.equal(h.values.has(replacementKey(input.order)),false);assert.deepEqual(h.values.get(responseExpiryKey(input.order)),prior);
  }
});
test('replacement commit rechecks the same retained proof and absence of conflicting history',async()=>{
  for(const mutate of ['proof','send','anchor']){
    const h=harness(),{input,source}=await h.expire('response-replacement-commit-'+mutate);
    h.rewrite(c=>{if(c.method==='getBlockHeight'){
      if(mutate==='proof'){const value=structuredClone(h.values.get(responseExpiryKey(input.order)));value.claimSha256='0'.repeat(64);h.values.set(responseExpiryKey(input.order),value);}
      else if(mutate==='anchor'){const value=structuredClone(h.values.get(anchorKey(input.order)));value.anchor.sourceSlot++;h.values.set(anchorKey(input.order),value);}
      else h.values.set(sendKey(input.order),{});
    }});
    assert.equal((await h.replace(source.input)).status,409);assert.equal(h.values.has(replacementKey(input.order)),false);
  }
});
test('write failure and silent drop cannot grant a replacement; lost durable acknowledgment restores without RPC after credential rotation',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),{input,source}=await h.expire('response-replacement-storage-'+fault),prior=structuredClone(h.values.get(responseExpiryKey(input.order)));h.fault(fault);
    const response=await h.replace(source.input);assert.equal(response.status,503);assert.equal((await response.json()).report,undefined);
    assert.equal(h.values.has(replacementKey(input.order)),fault==='ack');assert.deepEqual(h.values.get(responseExpiryKey(input.order)),prior);
    if(fault==='ack'){
      const record=structuredClone(h.values.get(replacementKey(input.order))),before=f.calls.length;h.restart('rotated-secret-42');
      const restored=await report(await h.replace(source.input));assert.equal(restored.restored,true);assert.deepEqual(restored.record,record);assert.equal(f.calls.length,before);
    }
  }
});
test('second missing-response expiry uses the replacement anchor, retains first expiry and refuses any third attempt',async()=>{
  const h=harness(),{input,source}=await h.expire('response-replacement-second-expiry'),next=await report(await h.replace(source.input));
  const partial=replacementPartial(f,source.input,next),second=missingResponse(signReplacement(f,partial));history.history([1550,1199]);history.set();
  const retired=await report(await h.call('review-response-expiry',second,{authorizeExpiryReview:true}));
  assert.equal(retired.proof.signature,null);assert.equal(retired.evidence.anchorSlot,1200);
  const closed=closeAttempt(f,second,retired);h.restart('rotated-secret-42');const before=f.calls.length;
  assert.equal((await h.replace(closed)).status,400);assert.equal((await h.call('replace',closed,{authorizeReplacement:true})).status,400);
  assert.equal((await report(await h.call('review-response-expiry',second,{authorizeExpiryReview:true}))).restored,true);
  assert.equal((await h.call('check',partial)).status,409);assert.equal(f.calls.length,before);
  assert.equal(h.values.has(responseExpiryKey(input.order)),true);assert.equal(h.values.has(responseExpiryKey(input.order,2)),true);
  assert.deepEqual(h.values.get(responseExpiryKey(input.order)),next.record.prior);
});
test('original cost consent and quote stay bound without becoming new consent; cached and later paths fail closed on loss',async()=>{
  const h=harness(),{input,source}=await h.expire('response-replacement-cost',true),key=costQuoteKey(input.walletClaim.costApproval.quote.quoteId);
  const saved=structuredClone(h.values.get(key)),before=f.calls.length;
  h.values.delete(key);assert.equal((await h.replace(source.input)).status,409);assert.equal(f.calls.length,before);h.values.set(key,saved);
  const next=await report(await h.replace(source.input)),partial=replacementPartial(f,source.input,next),full=signReplacement(f,partial),count=f.calls.length;
  assert.deepEqual(next.record.responseExpiry.walletClaim.costApproval,input.walletClaim.costApproval);
  for(const changed of [undefined,{...saved,issuedAt:saved.issuedAt+1}]){
    if(changed)h.values.set(key,changed);else h.values.delete(key);
    for(const [route,value,extra]of [['replace-response-expiry',source.input,{authorizeReplacement:true}],['check',partial,{}],
      ['send',full,{costApproval:input.walletClaim.costApproval}],['recover',full,{}]])
      assert.equal((await h.call(route,value,extra)).status,409,route);
  }
  h.values.set(key,saved);assert.equal(f.calls.length,count);
  const altered=structuredClone(source.input);altered.walletClaim.costApproval.approvedAt++;
  assert.equal((await h.replace(altered)).status,409);assert.equal(f.calls.length,count);
  const checked=await report(await h.call('check',partial));assert.notEqual(checked.costQuote.requestId,saved.requestId);
  const checkedCount=f.calls.length;
  assert.equal((await h.call('send',full,{costApproval:input.walletClaim.costApproval})).status,409);assert.equal(f.calls.length,checkedCount);
  assert.equal(f.calls.slice(before).some(c=>c.method==='sendTransaction'),false);
});
