// Native browser -> HTTPS -> workerd/SQLite -> intercepted SDK account RPC -> fake Wallet Standard.
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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-prewallet-replacement-fixture-'));
const output=path.resolve('operator/build/buyer-prewallet-replacement-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,loseFailureReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/recover-prewallet','/api/buyer/review-expiry','/api/buyer/replace'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      const body=await response.text();
      if(loseFailureReply&&req.url==='/api/buyer/replace'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable buyer gateway integration</title><script type="module" src="/fixture.js"></script>');}
  }catch(e){report.pageErrors.push('bridge:'+e.message);res.writeHead(503);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${server.address().port}`;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:true});
const base={cluster:'devnet',buyer:fixture.policy.owner,machine:fixture.plan.roles.machine,collection:fixture.plan.roles.collection,guard:fixture.plan.roles.guard};
const block={blockhash:fixture.key('hash').publicKey.toBase58(),lastValidBlockHeight:2000};
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.openGatewayClient);
}

const spaced=()=>new Promise(r=>setTimeout(r,250));
const discover=()=>page.evaluate(()=>prewalletRecovery.recover());
const discoverError=()=>page.evaluate(()=>code(prewalletRecovery.recover()));
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const read=s=>page.evaluate(s=>store.read(s),s);
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const observe=s=>page.evaluate(({s,secret})=>observedPrewalletBytes(s,secret),{s,secret:[...fixture.owner.secretKey]});
async function open(scope){await page.evaluate(s=>{window.auditScope=s;openSender(s);openPrewalletRecovery(s);},scope);}
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
async function setup(id,{native=false,observed=true}={}){
  fixture.setGeneration(1);fixture.setMode('normal');const scope={...base,id};await spaced();
  const status=await page.evaluate(async({s,native})=>{
    window.auditScope=s;const order=await store.create({...s,quantity:1,available:9999}),prepared=(await prepareThroughGateway({order})).candidate;
    window.writeFailure=native?null:'ready';const status=await code(store.prepareAssetSigning(s,prepared));window.writeFailure=null;return status;
  },{s:scope,native});
  assert.equal(status==='UNEXPECTED_SUCCESS',native);const signed=await observe(scope);if(observed)fixture.receipt(signed);
  await open(scope);await spaced();return{scope,bytes:signed};
}
async function walletSign(scope){
  await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
}
const replace=(ack='10000')=>page.evaluate(ack=>prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:ack}),ack);
async function failed(id,native=false){
  const item=await setup(id,{native});fixture.setMode('failure-finalized');assert.equal((await discover()).status,'failed');
  fixture.setGeneration(2);fixture.setMode('normal');return item;
}
const nativePrepare=(s,r)=>page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:'10000'}),{s,r});
try{
  await runtime.start();await launch();const first=await failed('prewallet-replacement-lost'),original=await rows(first.scope);await restart(first.scope);
  const before=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement())),'EXPLICIT_REPLACEMENT_REQUIRED');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'PAID_FEE_ACKNOWLEDGMENT_REQUIRED');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'0'}))),'PAID_FEE_ACKNOWLEDGMENT_REQUIRED');assert.equal(fixture.calls.length,before);
  loseFailureReply=true;await assert.rejects(replace());loseFailureReply=false;const savedCalls=fixture.calls.length;await restart(first.scope);
  const next=await replace();assert.equal(next.restored,true);assert.equal(next.record.version,3);assert.equal(next.candidate.orderRevision,2);assert.equal(fixture.calls.length,savedCalls);
  assert.deepEqual(await rows(first.scope),original);assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('exact paid fee acknowledgment is required before HTTP; lost preparation reply restores same hash across browser/SQLite restarts without changing first history');

  const partial=await nativePrepare(first.scope,next);assert.equal(partial.claim.orderRevision,3);assert.equal((await stats()).native,1);
  assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);await restart(first.scope);
  await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:first.scope,secret:[...fixture.owner.secretKey]});
  assert.equal(await page.evaluate(()=>code(client.signOnly())),'COST_APPROVAL_REQUIRED');assert.equal((await stats()).wallet,0);
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
  const signed=await page.evaluate(s=>store.readBuyerSubmission(s),first.scope);fixture.receipt(signed.input.response.transactionBase64);await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);
  const history=await page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],first.scope);
  assert.equal(history[0].prewallet.feeLamports,'10000');assert.equal(history[0].wallet,null);assert.equal(history[1].submission.status,'verified');
  report.cases.push('second native claim commits at real revision 3 without invented wallet events; fresh cost approval gates the new wallet signature and exact outcome preserves first fee evidence');

  const stale=await failed('prewallet-replacement-pause',true),candidate=await replace(),staleStats=await stats();
  await page.evaluate(s=>store.append(s,{type:'pause',revision:2}),stale.scope);await assert.rejects(nativePrepare(stale.scope,candidate));assert.deepEqual(await stats(),staleStats);
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  await page.evaluate(s=>store.append(s,{type:'resume',revision:3}),stale.scope);const rpc=fixture.calls.length,rebound=await replace();assert.equal(rebound.candidate.orderRevision,4);assert.equal(fixture.calls.length,rpc);
  await nativePrepare(stale.scope,rebound);assert.deepEqual((await rows(stale.scope)).slice(0,3).map(r=>r.phase),['claimed','ready','prewallet-recovered']);
  report.cases.push('pause blocks stale native preparation without signing; reviewed cached candidate binds to resumed revision and keeps the saved original partial');

  const abort=await failed('prewallet-replacement-abort'),abortRows=await rows(abort.scope),prepared=await replace(),count=await stats();
  await page.evaluate(()=>window.writeFailure='claimed');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  assert.deepEqual(await rows(abort.scope),abortRows);assert.deepEqual(await stats(),count);assert.equal((await read(abort.scope)).revision,2);
  await page.evaluate(()=>window.writeFailure='ready');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  const after=await stats();assert.equal(after.native,count.native+1);assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),abort.scope)).status,'asset-partial-saved');assert.deepEqual(await stats(),after);
  report.cases.push('aborted second claim creates no signature; lost ready write retains only the original new signature and recovers it without repeating the first or second sign');

  await walletSign(abort.scope);const second=await page.evaluate(s=>store.readBuyerSubmission(s),abort.scope);fixture.receipt(second.input.response.transactionBase64);fixture.setMode('failure-finalized');await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'failed');await restart(abort.scope);
  const failures=await page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],abort.scope);
  assert.equal(failures[0].prewallet.feeLamports,'10000');assert.equal(failures[1].submission.failureRecord.evidence.feeLamports,'10000');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  report.cases.push('two actual failed outcomes retain both paid fees after restart and neither replacement adapter permits a third attempt');

  const unknown=await setup('prewallet-replacement-unknown',{observed:false});const unknownCalls=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');assert.equal(fixture.calls.length,unknownCalls);
  const success=await setup('prewallet-replacement-verified');assert.equal((await discover()).status,'verified');const successCalls=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');assert.equal(fixture.calls.length,successCalls);
  report.cases.push('unknown and successful prewallet outcomes cannot request replacement or another signature');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
