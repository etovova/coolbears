import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hiddenBuyerGatewayFixture} from './fixtures/hidden-buyer-gateway.mjs';
import {makeBuyerGateway} from '../orders/gateway/worker.mjs';
import {createBuyerCheckClient} from '../orders/gateway/client.mjs';
import {validateWalletCheck} from '../orders/wallet-client.mjs';
import {runOrderCheck} from '../orders/check.mjs';
const origin='https://hidden-gateway.test',nonce='c'.repeat(64);
function harness(f){
  let now=Date.now();const data=new Map(f.preparations);
  const storage={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),transaction:async fn=>fn(storage)};
  const built=makeBuyerGateway(f.config(origin));
  const make=()=>new built.BuyerCheckGate({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(url,init)=>f.upstream(new Request(url,init))});let gate=make();
  return{data,dispatch:(input,route='check')=>gate.fetch(new Request(origin+'/api/buyer/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input})})),
    advance:()=>{now+=1000;},restart:()=>{gate=make();}};
}
for(const quantity of [1,50])test(`hidden gateway ${quantity}-item exact prepared check validates full machine and charges buyer current asset costs`,async()=>{
  const f=hiddenBuyerGatewayFixture({redeemed:999}),input=f.input('gateway-'+quantity,quantity),h=harness(f);
  const response=await h.dispatch(input),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  validateWalletCheck(body.report,input.order,input.request);
  assert.equal(body.report.budget.unitPriceLamports,'200000000');assert.equal(body.report.budget.protocolChargesLamports,'1500000');
  assert.equal(body.report.budget.nextItemFeeLamports,'10000');assert.equal(body.report.budget.priorityFeeLamports,'0');
  assert.equal(body.report.budget.baseAssetBytes,150);assert.equal(body.report.candidate.transactionBase64,input.request.transactionBase64);
  assert.equal(body.report.budget.nextItemKnownMinimumLamports,String(200000000n+10000n+BigInt(body.report.budget.nextItemBaseRentLamports)+1500000n));
  assert.equal(body.report.salesOpen,false);assert.equal(body.report.transactionsSent,0);assert.equal(body.report.readyToSubmit,false);
  assert.equal(f.calls.length,10);assert.ok(f.calls.every(c=>c.method!=='sendTransaction'));
  h.advance();h.restart();const client=createBuyerCheckClient({origin,fetchImpl:async(_url,init)=>h.dispatch(JSON.parse(init.body))});
  assert.equal((await client(input)).status,'wallet-check-passed');
});

test('hidden stale index, wrong simulation metadata, changed guard price and wrong genesis all deny signing through real gateway composition',async()=>{
  for(const [mode,code]of [['stale-index','MINT_INDEX_CHANGED'],['wrong-index','MINT_COST_UNVERIFIED'],['wrong-price','ACCOUNT_STATE_MISMATCH'],['wrong-genesis','RPC_GENESIS']]){
    const f=hiddenBuyerGatewayFixture(),input=f.input(mode),h=harness(f);f.setMode(mode);
    const response=await h.dispatch(input),body=await response.json();assert.equal(response.status,409,JSON.stringify(body));
    assert.equal(body.report.code,code,JSON.stringify(body));assert.equal(body.report.readyToSign,false);assert.equal(body.report.transactionsSent,0);
  }
});

test('hidden preparation restores one exact durable unsigned record after gateway restart without another blockhash or mutation',async()=>{
  const f=hiddenBuyerGatewayFixture(),order=f.order('fresh'),h=harness(f);
  const response=await h.dispatch({order},'prepare'),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.report.status,'prepared');assert.equal(body.report.readyToSign,false);assert.equal(body.report.salesOpen,false);
  const calls=f.calls.length;h.advance();h.restart();const restored=await(await h.dispatch({order},'prepare')).json();
  assert.equal(restored.report.restored,true);assert.deepEqual(restored.report.candidate,body.report.candidate);assert.equal(f.calls.length,calls);
});

test('explicit public storage-profile CLI performs complete hidden read-only preflight while default CLI rejects hidden mode before RPC',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'hidden-order-cli-'));
  try{
    const f=hiddenBuyerGatewayFixture({redeemed:9}),order=f.order('cli'),file=join(parent,'order.json'),profile=join(parent,'storage-profile.json');
    await writeFile(file,JSON.stringify(order));await writeFile(profile,JSON.stringify(f.storageOptions));
    const run=async args=>{let output='';const code=await runOrderCheck(args,{env:{COOLBEARS_BUYER_RPC_URL:'https://devnet.helius-rpc.com/?api-key=fixture-secret-42'},fetchImpl:(url,init)=>f.upstream(new Request(url,init)),output:{write:v=>{output+=v;}}});return{code,report:JSON.parse(output)};};
    const old=await run(['preflight',file]);assert.equal(old.code,1);assert.equal(old.report.networkRequests,0);assert.equal(f.calls.length,0);
    const hidden=await run(['preflight','--storage-profile',profile,file]);assert.equal(hidden.code,0,JSON.stringify(hidden.report));
    assert.equal(hidden.report.status,'preflight-passed');assert.equal(hidden.report.budget.baseAssetBytes,146);assert.equal(hidden.report.signaturesCreated,0);assert.equal(hidden.report.transactionsSent,0);
    assert.ok(!JSON.stringify(hidden.report).includes('fixture-secret-42'));assert.ok(!Object.hasOwn(hidden.report,'candidate'));
  }finally{await rm(parent,{recursive:true,force:true});}
});
