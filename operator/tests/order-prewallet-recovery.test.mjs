// Closed Devnet failure receipts, all signatures/RPC are disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {closeAttempt,replacementPartial,signReplacement} from './fixtures/buyer-replacement.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://prewallet-recovery.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
function harness(){
  f.setGeneration(1);f.setMode('normal');const values=new Map();let now=Date.now(),fault=null,rewrite;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-prewallet-recovery:')||k.startsWith('buyer-failure:')){if(fault==='write')throw Error('private disk detail');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){
    const saved=structuredClone(values);let result;try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
    if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-prewallet-recovery:')&&!saved.has(k))){fault=null;throw Error('lost commit reply');}return result;
  }};
  const create=(secret='fixture-secret-42')=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:secret},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>{const c=JSON.parse(i.body),r=await f.upstream(new Request(u,i));
      if(!rewrite)return r;const b=await r.json();rewrite(c,b);return Response.json(b);}});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  const prepare=async input=>{const order=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
    await report(await call('prepare',{order}));};
  return{values,call,prepare,restart:secret=>{gate=create(secret);},fault:v=>fault=v,rewrite:v=>rewrite=v};
}
import {prewalletRecoveryKey,validatePrewalletRecovery} from '../orders/prewallet-recovery.mjs';
import {createBuyerPrewalletRecovery} from '../orders/prewallet-recovery-client.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {VersionedTransaction} from '@solana/web3.js';
const pre=(id,native=false)=>({...f.input(id),...(!native?{request:null}:{})});
test('missing native bytes and saved partial both recover exact final outcome without wallet consent, claim or retry',async()=>{
  for(const native of [false,true]){
    const h=harness(),id='prewallet-positive-'+native,full=f.signedInput(id),input=pre(id,native);await h.prepare(input);
    f.receipt(full.response.transactionBase64);const before=f.calls.length;
    const found=await report(await h.call('recover-prewallet',input));validatePrewalletRecovery(found,input);
    assert.equal(found.status,'prewallet-recovered');assert.equal(found.result.status,'verified');assert.deepEqual(found.response,full.response);
    assert.equal(found.retryAuthorized,false);assert.equal(found.readyToSubmit,false);
    assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getSignaturesForAddress','getTransaction','getGenesisHash','getSignatureStatuses','getTransaction','getMultipleAccounts']);
    assert.deepEqual(f.calls[before+1].params,[input.claim.asset,{commitment:'finalized',limit:10,minContextSlot:600}]);
    assert.equal([...h.values.keys()].some(k=>/buyer-(send|failure|response-recovery|cost):/.test(k)),false);
    h.restart('rotated-secret-42');const count=f.calls.length;
    const paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:input.order.revision})};
    const restored=await report(await h.call('recover-prewallet',paused));assert.equal(restored.restored,true);assert.equal(restored.orderRevision,2);
    assert.equal((await report(await h.call('recover-prewallet',pre(id,true)))).restored,true);
    assert.equal((await report(await h.call('recover',full))).restored,true);
    assert.equal((await report(await h.call('recover-response',missingResponse(full)))).restored,true);
    for(const [route,value,extra]of [['send',full,{costApproval:{}}],['check',f.input(id),{}],['review-expiry',full,{authorizeExpiryReview:true}]])
      assert.equal((await h.call(route,value,extra)).status,409);
    assert.equal(f.calls.length,count);assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
  }
});
test('paid failed outcome preserves fee evidence in one record and cannot grant replacement',async()=>{
  const h=harness(),id='prewallet-failure',full=f.signedInput(id),input=pre(id);await h.prepare(input);
  f.receipt(full.response.transactionBase64);f.setMode('failure-finalized');
  const found=await report(await h.call('recover-prewallet',input));assert.equal(found.result.status,'failed');assert.equal(found.result.evidence.feeLamports,'10000');
  assert.deepEqual(h.values.get(prewalletRecoveryKey(input.order)).evidence,found.result.evidence);assert.equal(h.values.has(failureKey(full.order)),false);
  h.restart('rotated-secret-42');const before=f.calls.length;
  assert.equal((await report(await h.call('recover-prewallet',input))).restored,true);
  assert.equal((await report(await h.call('recover',full))).evidence.feeLamports,'10000');
  const source=closeAttempt(f,full,found.result);
  assert.equal((await h.call('replace',source,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'})).status,409);assert.equal(f.calls.length,before);
});
test('second native claim recovers only with genuine first fee proof and acknowledged replacement anchor',async()=>{
  const h=harness(),full=f.signedInput('prewallet-second');await h.prepare(full);f.receipt(full.response.transactionBase64);f.setMode('failure-finalized');
  const failed=await report(await h.call('recover',full)),source=closeAttempt(f,full,failed),first=structuredClone(h.values.get(failureKey(full.order)));
  f.setMode('normal');f.setGeneration(2);
  const replacement=await report(await h.call('replace',source,{authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  const partial=replacementPartial(f,source,replacement),second=signReplacement(f,partial),input={...partial,request:null};
  f.receipt(second.response.transactionBase64);const found=await report(await h.call('recover-prewallet',input));assert.equal(found.result.proof.slot,1450);
  assert.deepEqual(h.values.get(failureKey(full.order)),first);assert.equal(h.values.has(prewalletRecoveryKey(second.order,2)),true);
  h.restart('rotated-secret-42');const count=f.calls.length;assert.equal((await report(await h.call('recover-prewallet',input))).restored,true);assert.equal(f.calls.length,count);
  assert.equal((await h.call('send',second,{costApproval:{}})).status,409);
});
test('empty, bounded, contradictory, nonfinalized and cryptographically invalid discovery remains unknown',async()=>{
  const edits=[
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result=[];},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result=Array(10).fill(b.result[0]);},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result.push(b.result[0]);},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].slot=599;},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].confirmationStatus='confirmed';},
    (c,b)=>{if(c.method==='getSignaturesForAddress')b.result[0].err={InstructionError:[0,{Custom:1}]};},
    (c,b)=>{if(c.method==='getTransaction')b.result=null;},
    (c,b)=>{if(c.method==='getTransaction')b.result.transaction[0]='AAAA';},
    (c,b)=>{if(c.method==='getTransaction')b.result.version=1;},
    (c,b)=>{if(c.method==='getMultipleAccounts'&&c.params[0].length===1)b.result.value=[null];},
    ...[0,1].map(index=>(c,b)=>{if(c.method==='getTransaction'){const tx=VersionedTransaction.deserialize(Buffer.from(b.result.transaction[0],'base64'));tx.signatures[index][0]^=1;b.result.transaction[0]=Buffer.from(tx.serialize()).toString('base64');}}),
    (c,b)=>{if(c.method==='getTransaction')b.result.transaction[0]=f.signedInput('unrelated-prewallet').response.transactionBase64;},
  ];
  for(const [n,edit]of edits.entries()){
    const h=harness(),id='prewallet-negative-'+n,full=f.signedInput(id),input=pre(id);await h.prepare(input);f.receipt(full.response.transactionBase64);h.rewrite(edit);
    const result=await report(await h.call('recover-prewallet',input));assert.equal(result.status,'unknown',String(n));assert.equal(result.response,undefined);assert.equal(result.result,undefined);assert.equal(result.retryAuthorized,false);
    assert.equal(h.values.has(prewalletRecoveryKey(input.order)),false);
  }
});
test('missing anchor, invalid claim, malformed partial and invented wallet fields fail before RPC',async()=>{
  const h=harness(),id='prewallet-binding',input=pre(id),before=f.calls.length;
  assert.equal((await h.call('recover-prewallet',input)).status,409);assert.equal(f.calls.length,before);await h.prepare(input);
  for(const edit of [v=>v.claim.orderRevision++,v=>v.claim.messageSha256='0'.repeat(64),v=>v.request={transactionBase64:'AAAA'},
    v=>v.walletClaim={},v=>v.order=f.signedInput(id).order,v=>v.response=f.signedInput(id).response]){
    const changed=structuredClone(input);edit(changed);const count=f.calls.length;assert.equal((await h.call('recover-prewallet',changed)).status,400);assert.equal(f.calls.length,count);
  }
});
test('write rollback and lost durable commit acknowledgment never expose a half-terminal result',async()=>{
  for(const mode of ['normal','failure-finalized'])for(const fault of ['write','drop','ack']){
    const h=harness(),id='prewallet-storage-'+mode+'-'+fault,full=f.signedInput(id),input=pre(id);await h.prepare(input);
    f.receipt(full.response.transactionBase64);f.setMode(mode);h.fault(fault);const r=await h.call('recover-prewallet',input);
    assert.equal(r.status,503);assert.equal((await r.json()).report,undefined);assert.equal(h.values.has(prewalletRecoveryKey(input.order)),fault==='ack');assert.equal(h.values.has(failureKey(input.order)),false);
    if(fault==='ack'){h.restart('rotated-secret-42');const count=f.calls.length;assert.equal((await report(await h.call('recover-prewallet',input))).restored,true);assert.equal(f.calls.length,count);}
  }
});
test('corrupt or contradictory retained proof fails closed before RPC',async()=>{
  const h=harness(),id='prewallet-corrupt',input=pre(id);await h.prepare(input);f.receipt(f.signedInput(id).response.transactionBase64);
  await report(await h.call('recover-prewallet',input));const key=prewalletRecoveryKey(input.order),original=structuredClone(h.values.get(key)),count=f.calls.length;
  for(const edit of [v=>v.claimSha256='0'.repeat(64),v=>v.proof.account.owner=f.key('stranger').publicKey.toBase58(),v=>v.response.transactionBase64='AAAA']){
    const changed=structuredClone(original);edit(changed);h.values.set(key,changed);assert.equal((await h.call('recover-prewallet',input)).status,409);
  }
  h.values.set(key,original);h.values.set(failureKey(input.order),{});assert.equal((await h.call('recover-prewallet',input)).status,409);h.values.delete(failureKey(input.order));
  h.values.set(expiryKey(input.order),{});assert.equal((await h.call('recover-prewallet',input)).status,409);assert.equal(f.calls.length,count);
});
test('transport binds native presence, proof and order; controller restores a lost local ack without HTTP repetition',async()=>{
  const h=harness(),id='prewallet-client',input=pre(id);await h.prepare(input);f.receipt(f.signedInput(id).response.transactionBase64);
  const found=await report(await h.call('recover-prewallet',input));
  for(const edit of [v=>v.orderRevision++,v=>v.claimSha256='0'.repeat(64),v=>v.requestSha256='0'.repeat(64),v=>v.result.status='unknown',v=>v.result.signature='wrong',v=>v.response.transactionBase64='AAAA',v=>v.retryAuthorized=true]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,init)=>{const body=JSON.parse(init.body),r=structuredClone(found);edit(r);return Response.json({version:1,nonce:body.nonce,report:r});}});
    await assert.rejects(transport.recoverPrewallet(input));
  }
  let state={status:'prewallet-unknown',input},requests=0,saves=0;
  const client=createBuyerPrewalletRecovery({scope:{},transport:{recoverPrewallet:async()=>{requests++;return found;}},storage:{
    readPrewalletRecovery:async()=>state,savePrewalletRecovery:async()=>{saves++;state={status:'verified'};throw Error('LOST_LOCAL_ACK');}}});
  await assert.rejects(client.recover(),/LOST_LOCAL_ACK/);assert.equal((await client.recover()).status,'already-recorded');assert.equal(requests,1);assert.equal(saves,1);
});
