import test from 'node:test';
import assert from 'node:assert/strict';
import { buyerGatewayFixture } from './fixtures/buyer-gateway.mjs';
import { makeBuyerGateway } from '../orders/gateway/worker.mjs';
import { createBuyerCheckClient } from '../orders/gateway/client.mjs';
import { readJson } from '../orders/gateway/http.mjs';
import { validateWalletCheck } from '../orders/wallet-client.mjs';
const origin='https://buyer.test',endpoint=origin+'/api/buyer/check',f=await buyerGatewayFixture();
const env={BUYER_HELIUS_API_KEY:'fixture-secret-42'},nonce='a'.repeat(64),input=f.input();
function harness(extra={}){
  let now=Date.now(),value,fail=false;
  const storage={async get(){return structuredClone(value);},async put(k,v){if(fail)throw Error('storage unavailable');value=structuredClone(v);},
    async transaction(fn){const previous=structuredClone(value);try{return await fn(this);}catch(e){value=previous;throw e;}}};
  const {BuyerCheckGate}=makeBuyerGateway(f.config(origin));
  const create=(e=extra)=>new BuyerCheckGate({storage},{...env,...e},{clock:()=>now,pause:async ms=>{now+=ms;},
    fetchImpl:(url,init)=>f.upstream(new Request(url,init))});
  let gate=create();
  return{dispatch:(body={version:1,nonce,...input},options={})=>gate.fetch(new Request(options.url??endpoint,{method:'POST',headers:{origin,'content-type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body)})),
    restart:e=>{gate=create(e);},advance:ms=>{now+=ms;},ledger:()=>value,corrupt:()=>{value={version:1};},fail:value=>{fail=value;}};
}
test('real checker preserves exact partial for quantity 1 and 50 through fixed transport',async()=>{
  for(const quantity of [1,50]){
    const h=harness(),value=f.input('gateway-'+quantity,quantity),start=f.calls.length;
    const response=await h.dispatch({version:1,nonce,...value});const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));validateWalletCheck(body.report,value.order,value.request);
    assert.equal(body.report.candidate.transactionBase64,value.request.transactionBase64);
    assert.equal(body.report.networkRequests,10);assert.equal(body.report.transactionsSent,0);
    assert.equal(body.report.budget.complete,false);assert.equal(body.report.salesOpen,false);
    assert.deepEqual(h.ledger(),{version:1,day:h.ledger().day,checks:1,rpc:10,simulations:1,nextAt:h.ledger().nextAt,holdUntil:0,cooldownUntil:0});
    assert.equal(f.calls.length-start,10);assert.ok(!f.calls.slice(start).some(c=>/send|LatestBlockhash/.test(c.method)));
  }
});
test('origin, scope, closed buyer and exact bounded protocol reject without upstream',async()=>{
  const h=harness(),start=f.calls.length,valid={version:1,nonce,...input};
  const cases=[ [valid,{headers:{origin:'https://other.test'}},403],[valid,{headers:{cookie:'session=1'}},403],
    [valid,{headers:{authorization:'Bearer pretend'}},403],[valid,{url:endpoint+'?rpc=x'},404],
    [[valid],{},400],[{...valid,endpoint:'https://other.test'}, {},400],
    [JSON.stringify(valid).replace('"version":1','"version":1,"version":1'),{},400],
    [' '.repeat(65537),{},413],[{...valid,order:{...input.order,buyer:f.key('stranger').publicKey.toBase58()}},{},409],
    [{...valid,order:{...input.order,machine:f.key('stranger').publicKey.toBase58()}},{},400],
    [{...valid,request:{...input.request,transactionBase64:'AAAA'}},{},400] ];
  for(const [body,options,status]of cases)assert.equal((await h.dispatch(body,options)).status,status);
  assert.equal(f.calls.length,start);assert.equal(h.ledger(),undefined);
});
test('check quota survives restart, credential rotation and clock rollback; next UTC day resets counts',async()=>{
  const h=harness({DAILY_CHECK_CAP:'1'});assert.equal((await h.dispatch()).status,200);const before=f.calls.length;
  h.advance(1000);h.restart({DAILY_CHECK_CAP:'1',BUYER_HELIUS_API_KEY:'rotated-key-123'});
  assert.equal((await h.dispatch()).status,429);h.advance(-86400000);assert.equal((await h.dispatch()).status,429);
  assert.equal(f.calls.length,before);h.advance(2*86400000);h.restart({DAILY_CHECK_CAP:'1'});
  assert.equal((await h.dispatch()).status,200);assert.equal(h.ledger().checks,1);
});
test('RPC and simulation quotas charge before I/O and survive a new gate',async()=>{
  for(const settings of [{DAILY_RPC_CAP:'3'},{DAILY_SIMULATION_CAP:'1'}]){
    const h=harness(settings),before=f.calls.length;
    if(settings.DAILY_RPC_CAP){assert.equal((await h.dispatch()).status,429);assert.equal(f.calls.length-before,3);}
    else{assert.equal((await h.dispatch()).status,200);h.advance(1000);assert.equal((await h.dispatch()).status,429);assert.equal(h.ledger().simulations,1);}
    const charged=f.calls.length;h.restart(settings);assert.equal((await h.dispatch()).status,429);assert.equal(f.calls.length,charged);
  }
});
test('concurrent whole checks have one winner, persisted charge exists before first upstream',async()=>{
  const h=harness();f.setMode('hold');let entered;const ready=new Promise(r=>{entered=r;});
  f.onRequest(()=>{assert.equal(h.ledger().checks,1);assert.ok(h.ledger().rpc>=1);entered();});
  const pending=h.dispatch();await ready;const before=f.calls.length;
  const blocked=await Promise.all(Array.from({length:6},()=>h.dispatch()));assert.ok(blocked.every(r=>r.status===429));assert.equal(f.calls.length,before);
  f.setMode('normal');f.onRequest(null);f.release();assert.equal((await pending).status,200);
});
test('upstream 429/redirect redact secrets; uncertain hold and cooldown persist after restart',async()=>{
  for(const mode of ['429','redirect']){
    const h=harness();f.setMode(mode);const r=await h.dispatch(),text=await r.text();assert.ok(r.status>=400);assert.ok(!text.includes('fixture-secret-42'));assert.ok(!text.includes('forbidden.test'));
    const before=f.calls.length;h.restart();assert.equal((await h.dispatch()).status,429);assert.equal(f.calls.length,before);
    h.advance(46000);f.setMode('normal');assert.equal((await h.dispatch()).status,200);
  }
});
test('storage failure/corruption denies upstream without resetting saved ledger',async()=>{
  for(const mode of ['fail','corrupt']){const h=harness(),before=f.calls.length;mode==='fail'?h.fail(true):h.corrupt();assert.equal((await h.dispatch()).status,503);assert.equal(f.calls.length,before);}
});
test('account, simulation and expiry failures never authorize signing',async()=>{
  for(const mode of ['genesis','simulation','expired']){const h=harness();f.setMode(mode);const r=await h.dispatch(),body=await r.json();assert.equal(r.status,409);assert.equal(body.report.readyToSign,false);assert.equal(body.report.readyToSubmit,false);}
  f.setMode('normal');
});
test('real client fixes URL/headers and validates nonce plus server report',async()=>{
  const h=harness();let options;
  const client=createBuyerCheckClient({origin,fetchImpl:async(url,init)=>{assert.equal(url,endpoint);options=init;return h.dispatch(init.body);}});
  const report=await client(input);assert.equal(report.status,'wallet-check-passed');
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.mode,'same-origin');
  assert.deepEqual(options.headers,{'content-type':'application/json'});assert.ok(!options.body.includes('fixture-secret-42'));
  for(const change of [b=>b.nonce='b'.repeat(64),b=>b.report.expiresAt=0,b=>b.report.candidate.transactionBase64='AAAA']){
    const hh=harness();const bad=createBuyerCheckClient({origin,fetchImpl:async(url,init)=>{const b=await(await hh.dispatch(init.body)).json();change(b);return Response.json(b);}});
    await assert.rejects(bad(input));
  }
});
test('client timeout covers fetch and stalled response, rejects status and cancels body',async()=>{
  for(const fetchImpl of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}})]){
    const start=Date.now();await assert.rejects(createBuyerCheckClient({origin,fetchImpl,timeoutMs:20})(input));assert.ok(Date.now()-start<2000);
  }
  let canceled=false;
  await assert.rejects(createBuyerCheckClient({origin,fetchImpl:async()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{status:302})})(input));assert.equal(canceled,true);
  assert.throws(()=>createBuyerCheckClient({origin:'http://buyer.test'}));assert.throws(()=>createBuyerCheckClient({origin:origin+'/custom'}));
});
test('JSON reader bounds bytes and wall time, rejects duplicate keys, invalid UTF-8 and content encoding',async()=>{
  for(const bytes of ['{"x":1,"x":2}',new Uint8Array([255]),'x'.repeat(33)])await assert.rejects(readJson(new Response(bytes,{headers:{'content-type':'application/json'}}),{limit:32}));
  await assert.rejects(readJson(new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}})));
  const before=Date.now();await assert.rejects(readJson(new Response(new ReadableStream({pull(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}),{timeoutMs:20}));assert.ok(Date.now()-before<2000);
});
test('offline preparation pins order scope and refuses any overwrite or symlink input',async()=>{
  const {mkdtemp,writeFile,readFile,stat,symlink,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os'),{join}=await import('node:path');
  const {prepareBuyerGateway}=await import('../orders/gateway/prepare.mjs');
  const parent=await mkdtemp(join(tmpdir(),'coolbears-buyer-pin-'));
  try{
    const file=join(parent,'order.json'),directory=join(parent,'private');await writeFile(file,JSON.stringify(input.order));
    const result=await prepareBuyerGateway(file,origin,{directory});assert.equal(result.deployed,false);
    assert.deepEqual(JSON.parse(await readFile(join(directory,'config.json'),'utf8')),f.config(origin));
    assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'entry.mjs'))).mode&0o777,0o600);
    await assert.rejects(prepareBuyerGateway(file,origin,{directory}));
    const link=join(parent,'linked.json');await symlink(file,link);await assert.rejects(prepareBuyerGateway(link,origin,{directory:join(parent,'other')}));
  }finally{await rm(parent,{recursive:true,force:true});}
});
