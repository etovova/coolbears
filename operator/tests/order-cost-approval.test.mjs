// All RPC and wallet material are fixtures. Human consent cannot be proven by an HTTP field.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {createCostQuote,validateCostQuote,validateCostApproval,enforceCostCeiling,lamports,costQuoteKey} from '../orders/cost-approval.mjs';
import {createBuyerSubmissionTransport} from '../orders/gateway/submission-client.mjs';
import {createBuyerWalletClient} from '../orders/wallet-client.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://cost-approval.test',nonce='a'.repeat(64);
function harness(){
  const values=new Map();let now=Date.now(),failQuote=false;
  const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){if(failQuote&&k.startsWith('buyer-cost:'))throw Error('disk');values.set(k,structuredClone(v));},
    async transaction(fn){const saved=structuredClone(values);try{return await fn(this);}catch(e){values.clear();for(const [k,v]of saved)values.set(k,v);throw e;}}};
  const create=()=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(u,i)=>f.upstream(new Request(u,i))});
  let gate=create();const call=(route,input,costApproval)=>gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({version:1,nonce,...input,...(route==='send'?{costApproval}:{})})}));
  const prepare=async input=>{
    const order=f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
    const r=await call('prepare',{order});assert.equal(r.status,200,await r.clone().text());now+=1000;
  };
  return{values,call,prepare,advance:()=>{now+=46000;},restart:()=>{gate=create();},failQuote:()=>{failQuote=true;}};
}
async function issue(h,id){
  const input=f.input(id);await h.prepare(input);const r=await h.call('check',input);assert.equal(r.status,200,await r.clone().text());
  const report=(await r.json()).report,approval={version:1,quote:report.costQuote,maxTotalLamports:report.costQuote.budget.totalLamports,approvedAt:Date.now()};
  validateCostApproval(approval,input,{now:Date.now()});h.advance();return{input,report,approval};
}
test('cost amounts, complete arithmetic, identity and lifetime cannot be loosened by malformed consent',()=>{
  const input=f.input('strict'),approval=f.costApproval(input);
  for(const value of ['01','1.0','1e9','-1','9007199254740992',1,null,'',' 2'])assert.throws(()=>lamports(value));
  for(const edit of [a=>a.maxTotalLamports='1',a=>a.quote.budget.totalLamports='1',a=>a.quote.budget.quantity++,
    a=>a.quote.requestId='f'.repeat(64),a=>a.quote.quoteId='f'.repeat(64),a=>a.quote.expiresAt++,a=>a.approvedAt=a.quote.issuedAt-1,a=>a.extra=true]){
    const value=structuredClone(approval);edit(value);assert.throws(()=>validateCostApproval(value,input,{now:Date.now()}));
  }
  assert.throws(()=>validateCostApproval(approval,f.input('different')));
  assert.throws(()=>validateCostApproval(approval,input,{now:approval.quote.expiresAt}),/COST_APPROVAL_EXPIRED/);
  validateCostApproval(approval,input); // Historical evidence remains readable after expiry.
});
test('a real issued quote is committed before response and its original cap survives server restart',async()=>{
  const h=harness(),{input,report,approval}=await issue(h,'durable');
  assert.deepEqual(h.values.get(costQuoteKey(approval.quote.quoteId)),report.costQuote);
  h.restart();const signed=f.signedInput(input.order.id),before=f.calls.length;
  const r=await h.call('send',signed,approval);assert.equal(r.status,200,await r.clone().text());
  const claim=[...h.values.entries()].find(([k])=>k.startsWith('buyer-send:'))[1];assert.deepEqual(claim.costApproval,approval);
  assert.equal(f.calls.slice(before).filter(c=>c.method==='sendTransaction').length,1);
});
test('structurally valid fabricated or changed quotes are rejected before RPC or a send claim',async()=>{
  const h=harness(),input=f.signedInput('forged');await h.prepare(input);h.advance();const before=f.calls.length;
  const r=await h.call('send',input,f.costApproval(input));assert.equal(r.status,409);assert.equal((await r.json()).code,'COST_QUOTE_NOT_SAVED');
  assert.equal(f.calls.length,before);assert.equal([...h.values.keys()].some(k=>k.startsWith('buyer-send:')),false);
});
test('fresh cost over the cap blocks outbound send and leaves the permanent claim consumed',async()=>{
  const h=harness(),{input,approval}=await issue(h,'over-cap');f.setMode('fee-rise');const before=f.calls.length;
  try{const r=await h.call('send',f.signedInput(input.order.id),approval);assert.equal(r.status,409);assert.equal((await r.json()).code,'COST_LIMIT_EXCEEDED');}
  finally{f.setMode('normal');}
  assert.equal(f.calls.slice(before).some(c=>c.method==='sendTransaction'),false);
  h.restart();h.advance();const charged=f.calls.length;assert.equal((await h.call('send',f.signedInput(input.order.id),approval)).status,409);assert.equal(f.calls.length,charged);
});
test('an explicitly larger cap admits a fresh quote within that cap without changing the transaction',async()=>{
  const h=harness(),{input,approval}=await issue(h,'within-cap');approval.maxTotalLamports=String(BigInt(approval.maxTotalLamports)+10000n);
  f.setMode('fee-rise');const signed=f.signedInput(input.order.id),before=f.calls.length;
  try{const r=await h.call('send',signed,approval);assert.equal(r.status,200,await r.clone().text());}finally{f.setMode('normal');}
  assert.equal(f.calls.slice(before).find(c=>c.method==='sendTransaction').params[0],signed.response.transactionBase64);
});
test('failed quote persistence cannot issue a wallet grant; malformed current costs are never treated as zero',async()=>{
  const h=harness(),input=f.input('quote-disk');await h.prepare(input);h.failQuote();const r=await h.call('check',input);
  assert.equal(r.status,503);assert.equal((await r.json()).readyToSign,false);assert.equal([...h.values.keys()].some(k=>k.startsWith('buyer-cost:')),false);
  const ok=harness(),value=await issue(ok,'quote-arithmetic');
  for(const edit of [r=>r.budget.nextItemFeeLamports=null,r=>r.budget.nextItemKnownMinimumLamports='1',r=>r.budget.projectionOnly=false,r=>r.budget.fullOrderTotalLamports='1']){
    const report=structuredClone(value.report);edit(report);assert.throws(()=>enforceCostCeiling(value.approval,value.input,report));
  }
});
test('legacy signed evidence without consent can recover but cannot consume a new send claim',async()=>{
  const input=f.signedInput('legacy'),state={status:'ready',input,costApproval:null};let claims=0,recoveries=0;
  const storage={readBuyerSubmission:async()=>state,claimBuyerSubmission:async()=>{claims++;throw Error('forbidden');}};
  const transport={send:async()=>assert.fail('send forbidden'),recover:async value=>{recoveries++;return{...(await import('../orders/submission.mjs')).submissionBinding(value),status:'unknown',cluster:'devnet',readyToSubmit:false,salesOpen:false,chainVerified:false};}};
  const sender=createBuyerSender({storage,scope:{},transport,storageManager:{persisted:async()=>true}});
  await assert.rejects(sender.sendOnce({authorizeDevnetSend:true}),/COST_APPROVAL_REQUIRED/);assert.equal(claims,0);
  assert.equal((await sender.recover()).status,'unknown');assert.equal(recoveries,1);
});
test('expired saved consent cannot start a send, while historical quote validation remains possible',()=>{
  const input=f.input('expired'),approval=f.costApproval(input);
  validateCostQuote(approval.quote,input);
  assert.throws(()=>validateCostApproval(approval,input,{now:approval.quote.expiresAt+1}),/COST_APPROVAL_EXPIRED/);
});

test('submission HTTP acknowledgment remains bound to approved quote and cap',async()=>{
  const h=harness(),{input,approval}=await issue(h,'response-cap'),signed=f.signedInput(input.order.id);
  const transport=createBuyerSubmissionTransport({origin,fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body),r=await h.call('send',signed,body.costApproval),response=await r.json();
    assert.equal(r.status,200);response.nonce=body.nonce;response.report.maxTotalLamports='999999999';return Response.json(response);
  }});
  await assert.rejects(transport.send(signed,approval),/COST_RESPONSE/);
  const before=f.calls.length;assert.equal((await h.call('send',signed,approval)).status,409);assert.equal(f.calls.length,before);
});

test('missing/null cost options fail with the correct state before any check or wallet call',async()=>{
  const input=f.input('null-options');let calls=0,saved=null;
  const account={address:f.policy.owner,publicKey:f.owner.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={chains:['solana:devnet'],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},
    'standard:events':{on:()=>()=>{}},'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:()=>{calls++;throw Error('forbidden');}}}};
  const storage={read:async()=>input.order,readAssetSigning:async()=>({status:'asset-partial-saved',claim:input.claim,request:input.request}),readBuyerResponse:async()=>saved};
  const client=createBuyerWalletClient({storage,scope:input.order,checkPrepared:async()=>{calls++;throw Error('forbidden');},storageManager:{persisted:async()=>true}});
  await client.load();await client.connect(wallet);
  await assert.rejects(client.signOnly(null),/COST_APPROVAL_REQUIRED/);await assert.rejects(client.signOnly(),/COST_APPROVAL_REQUIRED/);
  saved={status:'wallet-response-unknown'};await client.load();await assert.rejects(client.signOnly(null),/NOT_READY/);assert.equal(calls,0);
});
