import test from 'node:test';
import assert from 'node:assert/strict';
import {VersionedTransaction} from '@solana/web3.js';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {verifyBuyerSigningResponse,prepareAssetClaim,finalizeAssetRequest} from '../orders/signing.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
import {validateBuyerResult,signedBytesId} from '../orders/submission.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://buyer-send.test',env={BUYER_HELIUS_API_KEY:'fixture-secret-42'},nonce='b'.repeat(64);
function signedInput(id='send-case'){
  const value=f.input(id);value.order=f.model.transitionOrder(value.order,{type:'unknown',revision:1,index:0,attempt:1});
  const tx=VersionedTransaction.deserialize(Buffer.from(value.request.transactionBase64,'base64'));tx.sign([f.owner]);
  const response={transactionBase64:Buffer.from(tx.serialize()).toString('base64')};const signed=verifyBuyerSigningResponse(value.order,value.claim,value.request,response);
  value.order=f.model.transitionOrder(value.order,{type:'signature',revision:2,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  return{...value,response};
}
function harness({enabled=true}={}){
  const values=new Map();let now=Date.now(),failSendClaim=false;
  const storage={async get(k){return structuredClone(values.get(k)??(k.startsWith('buyer-blockhash:')?f.preparations.get(k):undefined));},async put(k,v){if(failSendClaim&&k.startsWith('buyer-send:'))throw Error('disk');values.set(k,structuredClone(v));},async transaction(fn){return fn(this);}};
  const create=(settings={})=>new(makeBuyerGateway(f.config(origin),{allowSubmission:enabled}).BuyerCheckGate)({storage},{...env,...settings},{clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(url,init)=>f.upstream(new Request(url,init))});
  let gate=create();
  return{values,dispatch:(route,input,headers={})=>gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify({version:1,nonce,...input})})),
    fetch:(url,init)=>gate.fetch(new Request(url,{...init,headers:{...init.headers,origin}})),advance:ms=>{now+=ms;},restart:settings=>{gate=create(settings);},failClaim:()=>{failSendClaim=true;}};
}
test('send is disabled by default; opt-in and exact fully signed owner input are required',async()=>{
  const h=harness({enabled:false}),input=signedInput('disabled'),before=f.calls.length;
  assert.equal((await h.dispatch('send',input)).status,403);assert.equal(f.calls.length,before);
  const allowed=harness();assert.equal((await allowed.dispatch('send',{...input,response:{transactionBase64:input.request.transactionBase64}})).status,400);
  assert.equal((await allowed.dispatch('send',{...input,order:{...input.order,paused:true}})).status,409);assert.equal(f.calls.length,before);
});
test('durable server claim precedes signed simulation and a single exact send; restart and new order id cannot repeat',async()=>{
  const h=harness(),input=signedInput('accepted'),start=f.calls.length;
  f.onRequest(()=>assert.equal([...h.values.keys()].filter(k=>k.startsWith('buyer-send:')).length,1));
  const r=await h.dispatch('send',input),body=await r.json();f.onRequest(null);assert.equal(r.status,200,JSON.stringify(body));validateBuyerResult(body.report,input);
  const calls=f.calls.slice(start);assert.equal(calls.length,12);assert.equal(calls.filter(c=>c.method==='sendTransaction').length,1);
  const sim=calls.find(c=>c.method==='simulateTransaction');assert.equal(sim.params[0],input.response.transactionBase64);assert.equal(sim.params[1].sigVerify,true);
  assert.equal(calls.at(-1).params[0],input.response.transactionBase64);assert.equal(calls.at(-1).params[1].skipPreflight,false);assert.equal(calls.at(-1).params[1].maxRetries,0);
  h.restart({BUYER_HELIUS_API_KEY:'rotated-key-42'});h.advance(86400000);assert.equal((await h.dispatch('send',input)).status,409);assert.equal(f.calls.length,start+12);
  // Rebind valid identical wire bytes to a fully valid new order identity.
  const fresh=f.model.createOrder({...input.order,id:'other-id',available:9999,assets:input.order.items.map(i=>i.asset)});
  const prepared=prepareAssetClaim(fresh,{orderRevision:0,itemIndex:0,blockhash:input.claim.blockhash,lastValidBlockHeight:input.claim.lastValidBlockHeight,transactionBase64:input.claim.transactionBase64});
  const request=finalizeAssetRequest(prepared.order,prepared.claim,VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64')).signatures[1]);
  let order=f.model.transitionOrder(prepared.order,{type:'unknown',revision:1,index:0,attempt:1});
  const signed=verifyBuyerSigningResponse(order,prepared.claim,request,input.response);
  order=f.model.transitionOrder(order,{type:'signature',revision:2,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  assert.equal((await h.dispatch('send',{order,claim:prepared.claim,request,response:input.response})).status,409);assert.equal(f.calls.length,start+12);
});
test('lost/wrong send acknowledgment and signed-check failure consume the server claim permanently',async()=>{
  for(const mode of ['send-lost','send-wrong','simulation']){
    const h=harness(),input=signedInput(mode);f.setMode(mode);const r=await h.dispatch('send',input);assert.ok(r.status>=400);assert.ok(!(await r.text()).includes('fixture-secret-42'));
    const after=f.calls.length;h.restart();h.advance(86400000);f.setMode('normal');assert.equal((await h.dispatch('send',input)).status,409);assert.equal(f.calls.length,after);
  }
});
test('failed server claim storage prevents even simulation; parallel requests have one send',async()=>{
  const broken=harness();broken.failClaim();const before=f.calls.length;assert.equal((await broken.dispatch('send',signedInput('disk'))).status,503);assert.equal(f.calls.length,before);
  const h=harness(),input=signedInput('parallel');f.setMode('hold');let entered;const ready=new Promise(r=>entered=r);f.onRequest(()=>entered());const pending=h.dispatch('send',input);await ready;
  const rejected=await h.dispatch('send',input);assert.equal(rejected.status,429);f.setMode('normal');f.onRequest(null);f.release();assert.equal((await pending).status,200);
  assert.equal(f.calls.slice(before).filter(c=>c.method==='sendTransaction').length,1);
});
test('recovery requires matching finalized full bytes AND correct Core account; partial/failed evidence stays unknown',async()=>{
  const input=signedInput('recovery');f.receipt(input.response.transactionBase64);
  for(const mode of ['missing','pending','failed','wrong-bytes','absent-asset','wrong-owner','wrong-collection','wrong-uri','old-account']){
    const h=harness();f.setMode(mode);const r=await h.dispatch('recover',input),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.report.status,'unknown',mode);assert.equal(body.report.chainVerified,false);assert.equal(body.report.readyToSubmit,false);assert.equal(body.report.proof,undefined);
  }
  f.setMode('normal');const h=harness(),before=f.calls.length;const r=await h.dispatch('recover',input),body=await r.json();assert.equal(r.status,200);assert.equal(body.report.status,'verified',JSON.stringify(body));validateBuyerResult(body.report,input,{recovery:true});
  assert.deepEqual(f.calls.slice(before).map(c=>c.method),['getGenesisHash','getSignatureStatuses','getTransaction','getMultipleAccounts']);
  assert.equal(body.report.proof.account.owner,input.order.buyer);assert.equal(body.report.proof.account.collection,input.order.collection);
});
test('HTTP submission adapter binds nonce/bytes/order, omits credentials and has a complete deadline',async()=>{
  const h=harness(),input=signedInput('transport');let init;
  const transport=createBuyerSubmissionTransport({origin,fetchImpl:(url,options)=>{init=options;return h.fetch(url,options);}});
  const result=await transport.send(input);assert.equal(result.status,'accepted');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
  h.advance(1000);assert.equal((await transport.recover(input)).status,'verified');
  const altered=createBuyerSubmissionTransport({origin,fetchImpl:async(url,options)=>{h.advance(1000);const r=await h.fetch(url,options),b=await r.json();b.nonce='c'.repeat(64);return Response.json(b);}});
  await assert.rejects(altered.recover(input));
  let canceled=false;const hung=createBuyerSubmissionTransport({origin,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(hung.recover(input));assert.equal(canceled,true);
});
test('sender records its one-shot claim before transport and never repeats after timeout or lost local acknowledgment',async()=>{
  for(const lost of ['network','claim-ack']){
    let consumed=false,calls=0;const input=signedInput('sender-'+lost);
    const storage={readBuyerSubmission:async()=>({status:consumed?'send-claimed':'ready',input}),claimBuyerSubmission:async()=>{consumed=true;if(lost==='claim-ack')throw Error('lost commit reply');return{status:'send-claimed',input};}};
    const transport={send:async()=>{assert.equal(consumed,true);calls++;throw Error('network timeout');},recover:async()=>{throw Error('unused');}};
    const sender=createBuyerSender({storage,scope:{},transport,storageManager:{persisted:async()=>true}});
    await assert.rejects(sender.sendOnce(),/EXPLICIT_SEND_REQUIRED/);await assert.rejects(sender.sendOnce({authorizeDevnetSend:true}));
    await assert.rejects(sender.sendOnce({authorizeDevnetSend:true}),/SEND_NOT_READY/);assert.equal(calls,lost==='network'?1:0);
  }
});
