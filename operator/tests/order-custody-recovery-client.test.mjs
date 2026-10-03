// Real transaction/proof validators with disposable signatures and intercepted RPC.
// Browser persistence and missing-key behavior are covered by the browser suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {missingResponse} from './fixtures/buyer-missing-response.mjs';
import {recoverBuyerOrder} from '../orders/recovery.mjs';
import {responseRecoveryReport} from '../orders/response-recovery.mjs';
import {prewalletRecoveryReport} from '../orders/prewallet-recovery.mjs';
import {createBuyerCustodyRecovery} from '../orders/custody-recovery-client.mjs';
const f=await buyerGatewayFixture({syntheticOwner:true});approved.owner=f.policy.owner;
const methods={submission:'recover',response:'recoverResponse',prewallet:'recoverPrewallet'};
const flags={mode:'read-only-recovery',readOnly:true,readyToSign:false,readyToSubmit:false,retryAuthorized:false,salesOpen:false,transactionsSent:0};
const scope={id:'test-scope'};
function snapshot(source,input){
  const state={status:{submission:'ready',response:'wallet-response-unknown',prewallet:'prewallet-unknown'}[source],input};
  return{...flags,order:input.order,assetSigning:{claim:input.claim,request:input.request},
    buyerWallet:source==='prewallet'?null:{claim:input.walletClaim??null,response:input.response??null},
    submission:source==='submission'?state:null,responseRecovery:source==='response'?state:null,prewalletRecovery:source==='prewallet'?state:null,
    custody:{status:'unavailable',code:'ASSET_KEY_MISSING',items:input.order.items.map(i=>({index:i.index,asset:i.asset,status:'unavailable',code:'ASSET_KEY_MISSING'}))}};
}
async function fixture(source,id,{outcome='verified',partial=true}={}){
  const full=f.signedInput(id);f.receipt(full.response.transactionBase64);f.setMode(outcome==='unknown'?'missing':outcome==='failed'?'failure-finalized':'normal');
  const result=await recoverBuyerOrder({input:full,endpoint:'https://devnet.helius-rpc.com/?api-key=fixture-secret-42',fetchImpl:(u,i)=>f.upstream(new Request(u,i))});
  assert.equal(result.status,outcome);
  const input=source==='submission'?full:source==='response'?missingResponse(full):{...f.input(id),...(!partial?{request:null}:{})};
  const options={...(outcome!=='unknown'?{response:full.response,result}:{}),networkRequests:result.networkRequests};
  const report=source==='submission'?result:source==='response'?responseRecoveryReport(input,options):prewalletRecoveryReport(input,options);
  let current=snapshot(source,input),reads=0,calls=0,reply=report,action;
  const storage=new Proxy({readRecoverySnapshot:async saved=>{reads++;assert.deepEqual(saved,scope);return structuredClone(current);}},
    {get(target,key){if(key in target)return target[key];throw Error('FORBIDDEN_STORAGE_METHOD '+String(key));}});
  const transport=new Proxy({[methods[source]]:async value=>{calls++;assert.deepEqual(value,input);await action?.(value);return structuredClone(reply);}},
    {get(target,key){if(key in target)return target[key];throw Error('FORBIDDEN_TRANSPORT_METHOD '+String(key));}});
  const controller=createBuyerCustodyRecovery({storage,scope,transport});
  return{controller,input,report,result,get current(){return current;},set current(value){current=value;},
    get reads(){return reads;},get calls(){return calls;},set reply(value){reply=value;},set action(value){action=value;}};
}
const check=client=>client.check({authorizeCheck:true});
function closed(result){for(const [key,value]of Object.entries(flags))assert.equal(result[key],value);}
test('explicit read-only check uses only the matching recovery route and preserves all local evidence',async()=>{
  for(const source of Object.keys(methods))for(const outcome of ['verified','failed','unknown']){
    const h=await fixture(source,'custody-'+source+'-'+outcome,{outcome,partial:false}),before=structuredClone(h.current);
    const local=await h.controller.snapshot();assert.equal(h.calls,0);assert.equal(local.canCheck,true);assert.equal(local.source,source);closed(local);
    const result=await check(h.controller);assert.equal(result.status,outcome);assert.equal(result.source,source);closed(result);
    assert.deepEqual(result.report,h.report);assert.deepEqual(h.current,before);assert.equal(h.calls,1);assert.equal(h.reads,3);
    assert.equal(result.feeLamports,outcome==='failed'?'10000':undefined);assert.equal(result.outcome,outcome==='unknown'?undefined:outcome);
    assert.deepEqual(Object.keys(h.controller).sort(),['check','snapshot']);
  }
  assert.equal(f.calls.filter(c=>c.method==='sendTransaction').length,0);
});
test('missing explicit authorization never reads storage; missing order and fresh order never request the gateway',async()=>{
  const h=await fixture('submission','custody-empty');await assert.rejects(h.controller.check(),/EXPLICIT_RECOVERY_CHECK_REQUIRED/);assert.equal(h.reads,0);
  h.current=null;assert.equal((await h.controller.snapshot()).status,'missing-order');await assert.rejects(check(h.controller),/RECOVERY_EVIDENCE_REQUIRED/);
  const empty=f.model.createOrder({...h.input.order,available:9999,assets:h.input.order.items.map(i=>i.asset)});
  h.current={...snapshot('submission',h.input),order:empty,assetSigning:null,buyerWallet:null,submission:null};
  const local=await h.controller.snapshot();assert.equal(local.status,'no-outcome-evidence');assert.equal(local.canCheck,false);
  await assert.rejects(check(h.controller),/RECOVERY_EVIDENCE_REQUIRED/);assert.equal(h.calls,0);
});
test('saved terminal evidence returns already-recorded without transport or local writes',async()=>{
  for(const source of Object.keys(methods))for(const outcome of ['verified','failed','expired']){
    const h=await fixture(source,'custody-terminal-'+source+'-'+outcome,{outcome:outcome==='expired'?'verified':outcome});
    // The storage dependency independently replays all saved terminal evidence.
    // This router test receives its already validated result; expiry needs no new RPC.
    h.current.order.items[0].attempts.at(-1).state=outcome;
    const state={status:outcome,feeLamports:'10000',failureRecord:{evidence:{feeLamports:'10000'}}};
    h.current.submission=source==='submission'?state:null;h.current.responseRecovery=source==='response'?state:null;h.current.prewalletRecovery=source==='prewallet'?state:null;
    const result=await check(h.controller);assert.equal(result.status,'already-recorded');assert.equal(result.outcome,outcome);closed(result);
    assert.equal(result.feeLamports,outcome==='failed'?'10000':undefined);assert.equal(h.calls,0);assert.equal(h.reads,1);
  }
});
test('invalid canonical input or snapshot safety flags fail before transport',async()=>{
  for(const source of Object.keys(methods)){
    const h=await fixture(source,'custody-invalid-'+source),original=structuredClone(h.current),field={submission:'submission',response:'responseRecovery',prewallet:'prewalletRecovery'}[source];
    for(const edit of [v=>v.readyToSubmit=true,v=>v.order=null,v=>v[field].status='unsigned',v=>v[field].input.claim.asset=f.key('other-asset').publicKey.toBase58(),
      v=>v[field].input.order={...v.order,revision:v.order.revision+1}]){
      h.current=structuredClone(original);edit(h.current);await assert.rejects(check(h.controller));
    }
    assert.equal(h.calls,0);
  }
});
test('mismatched proofs, unsafe flags and foreign results are rejected without persisting',async()=>{
  for(const source of Object.keys(methods)){
    const h=await fixture(source,'custody-altered-'+source);
    const edits=[v=>v.orderRevision++,v=>v.transactionsSent=1,v=>v.retryAuthorized=true,v=>v.readyToSign=true,
      v=>(v.result??v).proof.account.owner=f.key('foreign-owner').publicKey.toBase58(),v=>(v.result??v).transactionsSent=1];
    for(const edit of edits){const report=structuredClone(h.report);edit(report);h.reply=report;await assert.rejects(check(h.controller));}
    h.reply=h.report;assert.equal((await check(h.controller)).status,'verified');
  }
});
test('changed canonical evidence during gateway review is rejected even when the response is valid',async()=>{
  for(const [index,edit]of [v=>{v.order=f.model.transitionOrder(v.order,{type:'pause',revision:v.order.revision});v.submission.input.order=v.order;},
    v=>{v.buyerWallet={...v.buyerWallet,claim:{claimId:'changed'}};},v=>{v.assetSigning={...v.assetSigning,extra:'changed'};},()=>null].entries()){
    const h=await fixture('submission','custody-stale-'+index);
    h.action=()=>{const changed=edit(h.current);if(changed===null)h.current=null;};
    await assert.rejects(check(h.controller),/STALE_RECOVERY_SNAPSHOT/);assert.equal(h.calls,1);assert.equal(h.reads,2);
  }
});
test('additional key loss during a request changes custody status without changing the canonical outcome binding',async()=>{
  const h=await fixture('submission','custody-keychange');h.current.custody={status:'available',code:null,items:[]};
  h.action=()=>{h.current.custody={status:'unavailable',code:'ASSET_KEY_MISSING',items:[]};};
  const result=await check(h.controller);assert.equal(result.status,'verified');assert.equal(result.custody.status,'unavailable');closed(result);
});
test('scope, request and returned snapshot are isolated from caller/dependency mutation',async()=>{
  const h=await fixture('response','custody-mutation');const before=structuredClone(h.current),local=await h.controller.snapshot();local.order.id='changed';local.custody.status='available';
  h.action=input=>{input.order.id='transport-mutated';input.walletClaim.claimId='0'.repeat(64);};
  assert.equal((await check(h.controller)).status,'verified');assert.deepEqual(h.current,before);
  const supplied={id:'immutable-scope'},received=[];
  const client=createBuyerCustodyRecovery({scope:supplied,storage:{readRecoverySnapshot:async value=>{received.push(value.id);value.id='dependency-mutated';return null;}}});
  supplied.id='caller-mutated';await client.snapshot();await client.snapshot();assert.deepEqual(received,['immutable-scope','immutable-scope']);
});
test('concurrent checks and snapshots are blocked and a failed request releases the client',async()=>{
  const h=await fixture('prewallet','custody-busy');let enter,release;
  const entered=new Promise(r=>enter=r);h.action=async()=>{enter();await new Promise(r=>release=r);throw Error('OFFLINE');};
  const pending=check(h.controller);await entered;
  await assert.rejects(check(h.controller),/BUSY/);await assert.rejects(h.controller.snapshot(),/BUSY/);
  release();await assert.rejects(pending,/OFFLINE/);h.action=null;
  assert.equal((await check(h.controller)).status,'verified');assert.equal(h.calls,2);
});
