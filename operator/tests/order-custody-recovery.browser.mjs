// Disposable Chromium -> HTTPS -> workerd/SQLite. No real wallets, RPC or funds.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {buyerGatewayRuntime,fixturePolicyPlugin} from './fixtures/buyer-gateway-runtime.mjs';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-custody-recovery-fixture-'));
const output=path.resolve('operator/build/buyer-custody-recovery-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0,httpFailures:[]};
const routes=['prepare','check','send','recover','recover-response','recover-prewallet','review-expiry','replace'];
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(routes.some(route=>req.url==='/api/buyer/'+route)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)}),body=await response.text();
      if(response.status!==200){
        let code;try{const value=JSON.parse(body).code;if(typeof value==='string'&&/^[A-Z_]+$/.test(value))code=value;}catch{}
        report.httpFailures.push({route:req.url,status:response.status,...(code?{code}:{})});
      }
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable custody outcome review</title><script type="module" src="/fixture.js"></script>');}
  }catch(e){report.pageErrors.push('bridge:'+e.message);res.writeHead(503);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${server.address().port}`;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:true});
const base={cluster:'devnet',buyer:fixture.policy.owner,machine:fixture.plan.roles.machine,collection:fixture.plan.roles.collection,guard:fixture.plan.roles.guard};
const spaced=()=>new Promise(r=>setTimeout(r,250));
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.openCustodyRecovery);
}
async function open(scope){await page.evaluate(s=>{window.auditScope=s;openSender(s);openResponseRecovery(s);openPrewalletRecovery(s);openCustodyRecovery(s);},scope);}
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const snapshot=()=>page.evaluate(()=>custodyRecovery.snapshot());
const check=async()=>{await spaced();return page.evaluate(()=>custodyRecovery.check({authorizeCheck:true}));};
const evidence=s=>page.evaluate(async s=>({
  order:await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(scopeKey(s))),
  events:await raw(['events'],'readonly',tx=>tx.objectStore('events').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),
  signing:await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),
  keys:await raw(['keys'],'readonly',tx=>tx.objectStore('keys').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),
}),s);
async function beginAudit(scope){const before=await evidence(scope),counts=await stats();await page.evaluate(()=>window.recoveryWriteAudit=[]);return{before,counts};}
async function unchanged(scope,audit){assert.deepEqual(await evidence(scope),audit.before);assert.deepEqual(await stats(),audit.counts);assert.deepEqual(await page.evaluate(()=>window.recoveryWriteAudit),[]);await page.evaluate(()=>window.recoveryWriteAudit=null);}
function readOnly(value){assert.equal(value.mode,'read-only-recovery');for(const key of ['readyToSign','readyToSubmit','retryAuthorized','salesOpen'])assert.equal(value[key],false);assert.equal(value.readOnly,true);assert.equal(value.transactionsSent,0);}
async function removeKey(scope,index=0){await page.evaluate(({s,index})=>raw(['keys'],'readwrite',tx=>tx.objectStore('keys').delete([scopeKey(s),index])),{s:scope,index});}
async function setup(id,{mode='signed',observe=true,quantity=2}={}){
  fixture.setGeneration(1);fixture.setMode('normal');const scope={...base,id};await spaced();
  const status=await page.evaluate(async({s,mode,quantity})=>{
    window.auditScope=s;window.recoveryWriteAudit=null;window.discardWalletResponse=false;
    const order=await store.create({...s,quantity,available:9999}),prepared=(await prepareThroughGateway({order})).candidate;
    window.writeFailure=mode==='prewallet'?'ready':null;const status=await code(store.prepareAssetSigning(s,prepared));window.writeFailure=null;return status;
  },{s:scope,mode,quantity});
  assert.equal(status==='UNEXPECTED_SUCCESS',mode!=='prewallet');let signed;
  if(mode==='prewallet')signed=await page.evaluate(({s,secret})=>observedPrewalletBytes(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});
  else{
    await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});
    await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();
    await page.evaluate(v=>window.discardWalletResponse=v,mode==='response');
    assert.equal(await page.evaluate(()=>code(client.signOnly(window.costConsent))),mode==='response'?'WALLET_RESPONSE_UNKNOWN':'UNEXPECTED_SUCCESS');
    signed=mode==='response'?await page.evaluate(()=>window.fixtureSignedBytes):(await page.evaluate(s=>store.readBuyerSubmission(s),scope)).input.response.transactionBase64;
  }
  if(observe)fixture.receipt(signed);await open(scope);return{scope,bytes:signed};
}
async function blockedMutable(scope){
  const results=await page.evaluate(async s=>({
    read:await code(store.read(s)),submission:await code(store.readBuyerSubmission(s)),native:await code(store.recoverAssetSigning(s)),
    append:await code(store.append(s,{type:'pause',revision:3})),send:await code(sender.sendOnce({authorizeDevnetSend:true})),
    response:await code(responseRecovery.recoverMissingResponse()),prewallet:await code(prewalletRecovery.recover()),
    replacement:await code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'})),
  }),scope);
  for(const [method,result]of Object.entries(results))assert.match(result,/ASSET_KEY_MISSING|INVALID_ASSET_KEY|ASSET_KEY_MISMATCH/,method+': '+result);
}
try{
  await runtime.start();await launch();
  const first=await setup('custody-first-key');await removeKey(first.scope);await restart(first.scope);let audit=await beginAudit(first.scope),calls=fixture.calls.length;
  const firstState=await snapshot();readOnly(firstState);assert.equal(firstState.source,'submission');assert.equal(firstState.canCheck,true);
  assert.equal(firstState.custody.status,'unavailable');assert.deepEqual(firstState.custody.items.map(item=>item.status),['unavailable','available']);
  assert.equal(await page.evaluate(()=>code(custodyRecovery.check())),'EXPLICIT_RECOVERY_CHECK_REQUIRED');assert.equal(fixture.calls.length,calls);
  await blockedMutable(first.scope);assert.equal(fixture.calls.length,calls);
  const firstResult=await check();readOnly(firstResult);assert.equal(firstResult.status,'verified');assert.equal(firstResult.outcome,'verified');
  await unchanged(first.scope,audit);assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('erased first key leaves later custody correctly identified; complete signed evidence is reviewed after browser/SQLite restart with no writes, signing, wallet call or send, while ordinary APIs remain blocked');

  await restart(first.scope);audit=await beginAudit(first.scope);calls=fixture.calls.length;
  const replay=await check();assert.equal(replay.status,'verified');assert.ok(fixture.calls.length>calls);await unchanged(first.scope,audit);
  report.cases.push('repeated signed-outcome review after another full restart performs fresh read RPC without adding local journal rows, signing again or sending');

  const later=await setup('custody-later-key');await removeKey(later.scope,1);audit=await beginAudit(later.scope);
  const laterState=await snapshot();assert.deepEqual(laterState.custody.items.map(item=>item.status),['available','unavailable']);
  assert.equal((await check()).status,'verified');await blockedMutable(later.scope);await unchanged(later.scope,audit);
  report.cases.push('loss of an unrelated later-item key preserves read-only access to the first signed attempt without restoring permission to mutate the order');

  for(const fault of ['mismatch','unusable']){
    const item=await setup('custody-key-'+fault);
    await page.evaluate(async({s,fault})=>{
      const privateKey=fault==='mismatch'?(await crypto.subtle.generateKey('Ed25519',false,['sign','verify'])).privateKey:{};
      await raw(['keys'],'readwrite',tx=>{const key=[scopeKey(s),0],r=tx.objectStore('keys').get(key);r.onsuccess=()=>tx.objectStore('keys').put({...r.result,privateKey},key);return r;});
    },{s:item.scope,fault});
    audit=await beginAudit(item.scope);const state=await snapshot();assert.equal(state.custody.status,'unavailable');
    assert.equal(state.custody.items[0].code,fault==='mismatch'?'ASSET_KEY_MISMATCH':'INVALID_ASSET_KEY');
    assert.equal((await check()).status,'verified');await blockedMutable(item.scope);await unchanged(item.scope,audit);
  }
  report.cases.push('mismatched non-extractable and unusable stored keys are reported separately; neither blocks canonical outcome review nor becomes signing authority');

  const response=await setup('custody-lost-response',{mode:'response'});await removeKey(response.scope);await restart(response.scope);audit=await beginAudit(response.scope);
  assert.equal((await snapshot()).source,'response');const responseResult=await check();assert.equal(responseResult.status,'verified');readOnly(responseResult);
  assert.equal(responseResult.report.status,'response-recovered');await unchanged(response.scope,audit);
  assert.deepEqual((await evidence(response.scope)).signing.map(row=>row.phase),['claimed','ready','wallet-claimed']);
  report.cases.push('lost wallet response discovers the exact finalized chain outcome despite missing custody and leaves its original wallet claim and absent response row untouched');

  const prewallet=await setup('custody-lost-native',{mode:'prewallet'});await removeKey(prewallet.scope);await restart(prewallet.scope);audit=await beginAudit(prewallet.scope);
  assert.equal((await snapshot()).source,'prewallet');const prewalletResult=await check();assert.equal(prewalletResult.status,'verified');readOnly(prewalletResult);
  assert.equal(prewalletResult.report.status,'prewallet-recovered');await unchanged(prewallet.scope,audit);
  assert.deepEqual((await evidence(prewallet.scope)).signing.map(row=>row.phase),['claimed']);
  report.cases.push('prewallet discovery works from the retained canonical native claim after restart without manufacturing a partial signature, wallet claim, recovered row or reconcile event');

  const unknown=await setup('custody-unknown',{mode:'response',observe:false});await removeKey(unknown.scope);await restart(unknown.scope);audit=await beginAudit(unknown.scope);
  let unknownResult=await check();assert.equal(unknownResult.status,'unknown');assert.equal(unknownResult.outcome,undefined);readOnly(unknownResult);await unchanged(unknown.scope,audit);
  fixture.receipt(unknown.bytes);fixture.setMode('pending');audit=await beginAudit(unknown.scope);unknownResult=await check();assert.equal(unknownResult.status,'unknown');await unchanged(unknown.scope,audit);
  fixture.setMode('normal');await restart(unknown.scope);audit=await beginAudit(unknown.scope);assert.equal((await check()).status,'verified');await unchanged(unknown.scope,audit);
  report.cases.push('empty and nonfinalized history remain unknown across custody loss; later final evidence can be shown without changing the consumed wallet claim or authorizing retry');

  const failed=await setup('custody-paid-failure');fixture.setMode('failure-finalized');await removeKey(failed.scope);audit=await beginAudit(failed.scope);
  const failure=await check();assert.equal(failure.status,'failed');assert.equal(failure.outcome,'failed');assert.equal(failure.report.evidence.feeLamports,'10000');readOnly(failure);await unchanged(failed.scope,audit);
  report.cases.push('a finalized failure retains the actual observed fee in its read-only report and grants no replacement, signing or send authority');

  const saved=await setup('custody-saved-terminal');await spaced();assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');await removeKey(saved.scope);await restart(saved.scope);
  audit=await beginAudit(saved.scope);calls=fixture.calls.length;const terminal=await check();assert.equal(terminal.status,'already-recorded');assert.equal(terminal.outcome,'verified');
  assert.equal(fixture.calls.length,calls);await unchanged(saved.scope,audit);
  report.cases.push('previously committed terminal proof remains readable after custody loss and needs no HTTP or RPC request');

  const unsigned={...base,id:'custody-unprepared'};await page.evaluate(s=>store.create({...s,quantity:1,available:9999}),unsigned);await removeKey(unsigned);await open(unsigned);audit=await beginAudit(unsigned);calls=fixture.calls.length;
  assert.equal((await snapshot()).status,'no-outcome-evidence');assert.equal(await page.evaluate(()=>code(custodyRecovery.check({authorizeCheck:true}))),'RECOVERY_EVIDENCE_REQUIRED');
  await unchanged(unsigned,audit);await open({...base,id:'custody-never-created'});assert.equal((await snapshot()).status,'missing-order');
  assert.equal(await page.evaluate(()=>code(custodyRecovery.check({authorizeCheck:true}))),'RECOVERY_EVIDENCE_REQUIRED');assert.equal(fixture.calls.length,calls);
  report.cases.push('an unsigned order or entirely absent scope has no recoverable outcome and creates no order, key, claim or network request');

  for(const fault of ['event','native-claim','all-signing','response','orphan']){
    const item=await setup('custody-corrupt-'+fault);await removeKey(item.scope);
    await page.evaluate(({s,fault})=>raw(['orders','events','signing'],'readwrite',tx=>{
      const key=scopeKey(s);
      if(fault==='event')return tx.objectStore('events').delete([key,1]);
      if(fault==='native-claim')return tx.objectStore('signing').delete([key,0,1,0]);
      if(fault==='all-signing')return tx.objectStore('signing').delete(IDBKeyRange.bound([key],[key,[]]));
      if(fault==='orphan')return tx.objectStore('orders').delete(key);
      const rowKey=[key,0,1,3],r=tx.objectStore('signing').get(rowKey);r.onsuccess=()=>{const row=r.result;row.record.transactionBase64='AAAA';tx.objectStore('signing').put(row,rowKey);};return r;
    }),{s:item.scope,fault});
    audit=await beginAudit(item.scope);calls=fixture.calls.length;
    assert.notEqual(await page.evaluate(()=>code(custodyRecovery.snapshot())),'UNEXPECTED_SUCCESS');
    assert.notEqual(await page.evaluate(()=>code(custodyRecovery.check({authorizeCheck:true}))),'UNEXPECTED_SUCCESS');
    assert.equal(fixture.calls.length,calls);await unchanged(item.scope,audit);
  }
  report.cases.push('broken event replay, missing native claim or all signing rows, changed response bytes and orphaned history all fail before RPC; custody loss never downgrades corrupt evidence into an unsigned order');

  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.httpFailures,[]);assert.equal(report.externalRequests,0);
  assert.equal(fixture.calls.filter(call=>call.method==='sendTransaction').length,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(call=>call.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
