import test from 'node:test';
import assert from 'node:assert/strict';
import {AddressLookupTableAccount,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {prewalletExpiryKey,validatePrewalletExpiry} from '../orders/prewallet-expiry.mjs';
import {prewalletRecoveryKey} from '../orders/prewallet-recovery.mjs';
import {expiryKey} from '../orders/expiry-review.mjs';
import {failureKey} from '../orders/failure-record.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerPrewalletRecovery} from '../orders/prewallet-recovery-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const history=prewalletExpiryFixture(f),{makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://prewallet-expiry.test',nonce='a'.repeat(64);
const report=async r=>{assert.equal(r.status,200,await r.clone().text());return(await r.json()).report;};
const pre=(id,native=false)=>({...f.input(id),...(!native?{request:null}:{})});
function harness(){
  history.set(false);history.history();history.rewrite(undefined);f.setGeneration(1);
  const values=new Map();let now=Date.now(),fault;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){
    if(k.startsWith('buyer-prewallet-expiry:')){if(fault==='write')throw Error('disk');if(fault==='drop')return;}
    values.set(k,structuredClone(v));},async transaction(fn){const saved=structuredClone(values);let result;
      try{result=await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}
      if(fault==='ack'&&[...values.keys()].some(k=>k.startsWith('buyer-prewallet-expiry:')&&!saved.has(k))){fault=null;throw Error('ack');}return result;}};
  const create=(secret='fixture-secret-42')=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:secret},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:async(u,i)=>f.upstream(new Request(u,i))});
  let gate=create();
  const call=async(route,input,extra={})=>{now+=1000;return gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...extra})}));};
  return{values,call,review:input=>call('review-prewallet-expiry',input,{authorizeExpiryReview:true}),
    async prepare(input){await report(await call('prepare',{order:f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)})}));history.set();},
    restart:()=>{gate=create('rotated-secret-42');},fault:v=>fault=v};
}
test('unsigned and partial claims retire only after finalized lifetime and complete inspected payer history; restart blocks all old operations',async()=>{
  for(const native of [false,true]){
    const h=harness(),id='unsigned-expiry-'+native,input=pre(id,native);await h.prepare(input);const before=f.calls.length;
    const result=await report(await h.review(input));validatePrewalletExpiry(result,input);assert.equal(result.status,'prewallet-expired');
    assert.equal(result.proof.signature,null);assert.equal(result.evidence.historyTransactions,2);assert.equal(result.retryAuthorized,false);
    const methods=f.calls.slice(before).map(c=>c.method);assert.equal(methods.filter(m=>m==='getTransaction').length,2);
    for(const m of ['sendTransaction','simulateTransaction','getSignatureStatuses','getLatestBlockhash'])assert.equal(methods.includes(m),false);
    assert.equal(h.values.has(prewalletExpiryKey(input.order)),true);assert.equal(h.values.has(expiryKey(input.order)),false);
    h.restart();const count=f.calls.length,paused={...input,order:f.model.transitionOrder(input.order,{type:'pause',revision:1})};
    assert.equal((await report(await h.review(paused))).restored,true);assert.equal((await report(await h.review(pre(id,true)))).restored,true);
    const full=f.signedInput(id);
    for(const [route,value,extra]of [['check',pre(id,true),{}],['send',full,{costApproval:{}}],['recover',full,{}],['recover-prewallet',input,{}],['review-expiry',full,{authorizeExpiryReview:true}]])
      assert.equal((await h.call(route,value,extra)).status,409);
    assert.equal(f.calls.length,count);
  }
});
test('two bounded pages reach an actual older row; truncation or cap exhaustion cannot prove absence',async()=>{
  for(const [n,slots,expected]of [[1,[...Array.from({length:10},(_,i)=>850-i),599],'prewallet-expired'],[2,[850],'unknown'],[3,[],'unknown'],[4,Array.from({length:20},(_,i)=>850-i),'unknown']]){
    const h=harness(),input=pre('expiry-pages-'+n);await h.prepare(input);history.history(slots);
    const result=await report(await h.review(input));assert.equal(result.status,expected);assert.equal(result.retryAuthorized,false);
    if(expected==='prewallet-expired'){assert.equal(result.evidence.historyPages,2);assert.equal(result.evidence.historyTransactions,11);}
    else assert.equal(h.values.has(prewalletExpiryKey(input.order)),false);
  }
});
test('live hash, pruned history, stale account, observed asset, missing bytes, invalid signatures and inconsistent history remain unknown',async()=>{
  const edits=[
    (c,b)=>{if(c.method==='isBlockhashValid')b.result.value=true;},
    (c,b)=>{if(c.method==='getBlock'&&c.params[0]===900)b.result.blockHeight=2000;},
    (c,b)=>{if(c.method==='getBlock'&&c.params[0]===600)b.result.blockhash=f.key('wrong').publicKey.toBase58();},
    (c,b)=>{if(c.method==='getFirstAvailableBlock')b.result=601;},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.context.slot=899;},
    (c,b)=>{if(c.method==='getMultipleAccounts')b.result.value=[{}];},
    (c,b)=>{if(c.method==='getSignaturesForAddress'&&c.params[0]!==f.policy.owner)b.result=history.rows;},
    (c,b)=>{if(c.method==='getSignaturesForAddress'&&c.params[0]===f.policy.owner)b.result[0].confirmationStatus='confirmed';},
    (c,b)=>{if(c.method==='getSignaturesForAddress'&&c.params[0]===f.policy.owner)b.result.push(b.result[0]);},
    (c,b)=>{if(c.method==='getTransaction')b.result=null;},
    (c,b)=>{if(c.method==='getTransaction')b.result.slot++;},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.err={Custom:1};},
    (c,b)=>{if(c.method==='getTransaction'){const tx=VersionedTransaction.deserialize(Buffer.from(b.result.transaction[0],'base64'));tx.signatures[0][0]^=1;b.result.transaction[0]=Buffer.from(tx.serialize()).toString('base64');}},
    (c,b)=>{if(c.method==='getTransaction')b.result.meta.loadedAddresses={writable:[f.policy.owner],readonly:[]};},
  ];
  for(const [n,edit]of edits.entries()){
    const h=harness(),input=pre('expiry-negative-'+n);await h.prepare(input);history.rewrite(edit);
    const result=await report(await h.review(input));assert.equal(result.status,'unknown',String(n));assert.equal(result.proof,undefined);assert.equal(result.evidence,undefined);
    assert.equal(h.values.has(prewalletExpiryKey(input.order)),false);
  }
});
test('a signed mint in payer history blocks retirement even when asset account and address history say absent',async()=>{
  const h=harness(),input=pre('expiry-observed'),full=f.signedInput(input.order.id);await h.prepare(input);
  const signature=full.order.items[0].attempts[0].signature;
  history.rewrite((c,b)=>{
    if(c.method==='getSignaturesForAddress'&&c.params[0]===f.policy.owner)b.result=[{signature,slot:850,err:{Custom:1},confirmationStatus:'finalized'},history.rows[1]];
    if(c.method==='getTransaction'&&c.params[0]===signature)b.result={slot:850,version:0,transaction:[full.response.transactionBase64,'base64'],meta:{err:{Custom:1}}};
  });
  const result=await report(await h.review(input));assert.equal(result.status,'unknown');assert.equal(result.code,'EXPIRY_TRANSACTION_OBSERVED');
  assert.equal(h.values.has(prewalletExpiryKey(input.order)),false);
});
test('loaded addresses participate in the absence check with exact table lengths; unrelated v0 lookups remain reviewable',async()=>{
  for(const observed of [false,true]){
    const h=harness(),input=pre('expiry-lookup-'+observed);await h.prepare(input);
    const target=observed?f.key('asset-'+input.order.id+'-0').publicKey:f.key('unrelated-lookup-recipient').publicKey;
    const table=new AddressLookupTableAccount({key:f.key('history-lookup').publicKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:[target]}});
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:f.owner.publicKey,recentBlockhash:f.key('history-lookup-hash').publicKey.toBase58(),
      instructions:[SystemProgram.transfer({fromPubkey:f.owner.publicKey,toPubkey:target,lamports:1})]}).compileToV0Message([table]));tx.sign([f.owner]);
    assert.equal(tx.message.addressTableLookups.length,1);const signature=base58.deserialize(tx.signatures[0])[0];
    history.rewrite((c,b)=>{
      if(c.method==='getSignaturesForAddress'&&c.params[0]===f.policy.owner)b.result=[{signature,slot:850,err:null,confirmationStatus:'finalized'},history.rows[1]];
      if(c.method==='getTransaction'&&c.params[0]===signature)b.result={slot:850,version:0,transaction:[Buffer.from(tx.serialize()).toString('base64'),'base64'],
        meta:{err:null,loadedAddresses:{writable:[target.toBase58()],readonly:[]}}};
    });
    const result=await report(await h.review(input));assert.equal(result.status,observed?'unknown':'prewallet-expired');
    if(observed)assert.equal(result.code,'EXPIRY_TRANSACTION_OBSERVED');
  }
});
test('archive pruning and asset changes during the review fail the final read before any record is written',async()=>{
  for(const fault of ['archive','account','history']){
    const h=harness(),input=pre('expiry-final-'+fault);await h.prepare(input);let n=0;
    history.rewrite((c,b)=>{
      if(fault==='archive'&&c.method==='getFirstAvailableBlock'&&++n===2)b.result=601;
      if(fault==='account'&&c.method==='getMultipleAccounts'&&++n===2)b.result.value=[{}];
      if(fault==='history'&&c.method==='getSignaturesForAddress'&&c.params[0]===input.claim.asset&&++n===2)b.result=history.rows;
    });
    assert.equal((await report(await h.review(input))).status,'unknown');assert.equal(h.values.has(prewalletExpiryKey(input.order)),false);
  }
});
test('explicit review, exact claim, saved anchor and consistent terminal records are required before RPC',async()=>{
  const h=harness(),input=pre('expiry-input');let count=f.calls.length;
  assert.equal((await h.review(input)).status,409);assert.equal(f.calls.length,count);await h.prepare(input);count=f.calls.length;
  assert.equal((await h.call('review-prewallet-expiry',input)).status,400);
  for(const edit of [v=>v.claim.messageSha256='0'.repeat(64),v=>v.request={},v=>v.response={},v=>v.order=f.signedInput(input.order.id).order]){
    const v=structuredClone(input);edit(v);assert.equal((await h.review(v)).status,400);
  }
  assert.equal(f.calls.length,count);await report(await h.review(input));count=f.calls.length;
  const key=prewalletExpiryKey(input.order),saved=structuredClone(h.values.get(key));
  for(const edit of [v=>v.claimSha256='0'.repeat(64),v=>v.proof.signature='1'.repeat(64),v=>v.evidence.historyTransactions=21,v=>v.evidence.historyPages=0]){
    const v=structuredClone(saved);edit(v);h.values.set(key,v);assert.equal((await h.review(input)).status,409);
  }
  h.values.set(key,saved);
  for(const k of [failureKey(input.order),expiryKey(input.order),prewalletRecoveryKey(input.order)]){h.values.set(k,{});assert.equal((await h.review(input)).status,409);h.values.delete(k);}
  assert.equal(f.calls.length,count);
});
test('durable rollback, silent drop and lost commit acknowledgment cannot expose an unsaved retirement',async()=>{
  for(const fault of ['write','drop','ack']){
    const h=harness(),input=pre('expiry-storage-'+fault);await h.prepare(input);h.fault(fault);
    const r=await h.review(input);assert.equal(r.status,503);assert.equal((await r.json()).report,undefined);
    assert.equal(h.values.has(prewalletExpiryKey(input.order)),fault==='ack');
    if(fault==='ack'){h.restart();const count=f.calls.length;assert.equal((await report(await h.review(input))).restored,true);assert.equal(f.calls.length,count);}
  }
});
test('transport rejects altered absence bindings; controller requires explicit review and reads a lost local acknowledgment without retrying HTTP',async()=>{
  const h=harness(),input=pre('expiry-client');await h.prepare(input);const found=await report(await h.review(input));
  for(const edit of [v=>v.orderRevision++,v=>v.requestSha256='0'.repeat(64),v=>v.proof.signature='invented',v=>v.retryAuthorized=true,v=>v.evidence.historyTransactions=0]){
    const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_u,i)=>{const b=JSON.parse(i.body),r=structuredClone(found);edit(r);return Response.json({version:1,nonce:b.nonce,report:r});}});
    await assert.rejects(transport.reviewPrewalletExpiry(input));
  }
  let state={status:'prewallet-unknown',input},requests=0,saves=0;
  const client=createBuyerPrewalletRecovery({scope:{},transport:{recoverPrewallet:async()=>{},reviewPrewalletExpiry:async()=>{requests++;return found;}},storage:{
    readPrewalletRecovery:async()=>state,savePrewalletRecovery:async()=>{},savePrewalletExpiry:async()=>{saves++;state={status:'expired'};throw Error('LOST_LOCAL_ACK');}}});
  await assert.rejects(client.reviewExpiry(),/EXPLICIT_EXPIRY_REVIEW_REQUIRED/);assert.equal(requests,0);
  await assert.rejects(client.reviewExpiry({authorizeExpiryReview:true}),/LOST_LOCAL_ACK/);
  assert.equal((await client.reviewExpiry({authorizeExpiryReview:true})).status,'already-recorded');assert.equal((await client.recover()).outcome,'expired');
  assert.equal(requests,1);assert.equal(saves,1);assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
