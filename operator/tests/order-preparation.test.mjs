// Durable provenance through the real HTTP implementation; no live network.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {anchorKey} from '../orders/blockhash-anchor.mjs';
import {prepareAssetClaim,finalizeAssetRequest} from '../orders/signing.mjs';
import {VersionedTransaction} from '@solana/web3.js';
import {createBuyerPreparationClient} from '../orders/gateway/preparation-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const {makeBuyerGateway}=await import('../orders/gateway/worker.mjs');
const origin='https://preparation.test',nonce='a'.repeat(64);
const fresh=input=>f.model.createOrder({...input.order,available:9999,assets:input.order.items.map(i=>i.asset)});
function harness(){
  let now=Date.now(),lostAck=false,failRead=false;const values=new Map();
  const storage={async get(k){if(failRead&&k.startsWith('buyer-blockhash:'))throw Error('read failed');return structuredClone(values.get(k));},
    async put(k,v){values.set(k,structuredClone(v));if(lostAck&&k.startsWith('buyer-blockhash:'))throw Error('ack lost');},async transaction(fn){return fn(this);}};
  const create=(extra={})=>new(makeBuyerGateway(f.config(origin),{allowSubmission:true}).BuyerCheckGate)({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42',...extra},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(u,i)=>f.upstream(new Request(u,i))});
  let gate=create();const fetch=(url,init)=>gate.fetch(new Request(url,{...init,headers:{...init.headers,origin}}));
  return{values,fetch,restart:extra=>{gate=create(extra);},advance:()=>{now+=46000;},loseAck:()=>{lostAck=true;},failRead:()=>{failRead=true;},
    call:(route,input)=>fetch(origin+'/api/buyer/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input,...(route==='send'?{costApproval:f.costApproval(input)}:{})})})};
}
test('legacy and caller-created hashes cannot grant signing or submission without trusted durable provenance',async()=>{
  const h=harness(),start=f.calls.length;
  for(const [route,input]of [['check',f.input('no-anchor')],['send',f.signedInput('no-anchor-send')]]){
    const r=await h.call(route,input);assert.equal(r.status,409);assert.equal((await r.json()).code,'BLOCKHASH_ANCHOR_REQUIRED');
  }
  assert.equal(f.calls.length,start);assert.equal(h.values.size,0);
});
test('HTTP preparation pins the original RPC blockhash before response; restart/lost HTTP reply restores exact candidate without refreshing',async()=>{
  const h=harness(),input=f.input('prepare-roundtrip'),order=fresh(input),start=f.calls.length;
  const client=createBuyerPreparationClient({origin,fetchImpl:h.fetch});
  const first=await client({order});assert.equal(first.restored,false);assert.equal(first.readyToSign,false);
  assert.deepEqual(f.calls.slice(start).map(c=>c.method),['getGenesisHash','getLatestBlockhash','getBlockHeight']);
  assert.equal(first.anchor.lastValidBlockHeight,2000);assert.equal(first.anchor.sourceSlot,600);
  h.restart({BUYER_HELIUS_API_KEY:'rotated-fixture-key'});
  const again=await client({order});assert.deepEqual({...again,restored:false},first);assert.equal(f.calls.length,start+3);
  h.restart();h.advance();const checked=await h.call('check',input);assert.equal(checked.status,200,await checked.clone().text());
  const report=(await checked.json()).report;assert.equal(report.blockhashProvenanceVerified,true);assert.equal(report.budget.complete,true);
});
test('a valid rebind of identical wire bytes cannot inflate expiry or change the order behind its asset',async()=>{
  const h=harness(),input=f.input('rebind'),order=fresh(input);assert.equal((await h.call('prepare',{order})).status,200);h.advance();
  const before=f.calls.length;
  const prepared=prepareAssetClaim(order,{orderRevision:0,itemIndex:0,blockhash:input.claim.blockhash,lastValidBlockHeight:999999,transactionBase64:input.claim.transactionBase64});
  const signature=VersionedTransaction.deserialize(Buffer.from(input.request.transactionBase64,'base64')).signatures[1];
  const request=finalizeAssetRequest(prepared.order,prepared.claim,signature);
  assert.equal((await h.call('check',{order:prepared.order,claim:prepared.claim,request})).status,409);
  assert.equal((await h.call('prepare',{order:{...order,id:'another-id'}})).status,409);
  assert.equal(f.calls.length,before);
});
test('ambiguous preparation storage does not issue a second hash; corrupt or unreadable anchors never authorize RPC',async()=>{
  const h=harness(),input=f.input('lost-storage'),order=fresh(input);h.loseAck();
  assert.equal((await h.call('prepare',{order})).status,503);const before=f.calls.length;
  h.restart();const restored=await h.call('prepare',{order});assert.equal(restored.status,200);assert.equal((await restored.json()).report.restored,true);
  assert.equal(f.calls.length,before);
  h.values.set(anchorKey(order),{anchor:{version:1}});
  assert.equal((await h.call('check',input)).status,409);assert.equal((await h.call('prepare',{order})).status,409);
  h.failRead();assert.equal((await h.call('check',input)).status,503);assert.equal(f.calls.length,before);
});
test('preparation consumes the same durable quota and invalid network cannot save an anchor',async()=>{
  const h=harness(),input=f.input('quota');h.restart({DAILY_CHECK_CAP:'1'});
  assert.equal((await h.call('prepare',{order:fresh(input)})).status,200);h.advance();const before=f.calls.length;
  assert.equal((await h.call('check',input)).status,429);assert.equal(f.calls.length,before);
  const bad=harness();f.setMode('genesis');assert.equal((await bad.call('prepare',{order:fresh(input)})).status,503);f.setMode('normal');
  assert.equal(bad.values.has(anchorKey(input.order)),false);
});
test('preparation client rejects altered candidate, nonce or provenance and bounds a stalled body',async()=>{
  const input=f.input('bad-client'),order=fresh(input);
  for(const change of [b=>b.nonce='b'.repeat(64),b=>b.report.candidate.lastValidBlockHeight++,b=>b.report.anchor.sourceSlot=-1,b=>b.report.readyToSign=true]){
    const h=harness(),client=createBuyerPreparationClient({origin,fetchImpl:async(u,i)=>{const body=await(await h.fetch(u,i)).json();change(body);return Response.json(body);}});
    await assert.rejects(client({order}));
  }
  let cancelled=false;const client=createBuyerPreparationClient({origin,timeoutMs:15,fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(client({order}));assert.equal(cancelled,true);
});

test('near-expiry RPC preparation is not saved or converted into a fresh lifetime',async()=>{
  const h=harness(),input=f.input('near-expiry');f.setMode('near-expiry');
  try{const r=await h.call('prepare',{order:fresh(input)});assert.equal(r.status,409);assert.equal((await r.json()).code,'BLOCKHASH_TOO_OLD');
    assert.equal(h.values.has(anchorKey(input.order)),false);}finally{f.setMode('normal');}
});
