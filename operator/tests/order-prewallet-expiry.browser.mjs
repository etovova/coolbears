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
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {buyerGatewayRuntime,fixturePolicyPlugin} from './fixtures/buyer-gateway-runtime.mjs';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-prewallet-expiry-fixture-'));
const output=path.resolve('operator/build/buyer-prewallet-expiry-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
const history=prewalletExpiryFixture(fixture);
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,loseFailureReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/review-prewallet-expiry','/api/buyer/review-expiry','/api/buyer/replace'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      const body=await response.text();
      if(loseFailureReply&&req.url==='/api/buyer/review-prewallet-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable buyer gateway integration</title><script type="module" src="/fixture.js"></script>');}
  }catch(e){report.pageErrors.push('bridge:'+e.message);res.writeHead(503);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${server.address().port}`;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:true});
const base={cluster:'devnet',buyer:fixture.policy.owner,machine:fixture.plan.roles.machine,collection:fixture.plan.roles.collection,guard:fixture.plan.roles.guard};
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.openGatewayClient);
}

const spaced=()=>new Promise(r=>setTimeout(r,250));
const review=()=>page.evaluate(()=>prewalletRecovery.reviewExpiry({authorizeExpiryReview:true}));
const reviewError=()=>page.evaluate(()=>code(prewalletRecovery.reviewExpiry({authorizeExpiryReview:true})));
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const read=s=>page.evaluate(s=>store.read(s),s);
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const observe=s=>page.evaluate(({s,secret})=>observedPrewalletBytes(s,secret),{s,secret:[...fixture.owner.secretKey]});
async function open(scope){await page.evaluate(s=>{window.auditScope=s;openSender(s);openPrewalletRecovery(s);},scope);}
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
async function setup(id,{native=false}={}){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);const scope={...base,id};await spaced();
  const status=await page.evaluate(async({s,native})=>{
    window.auditScope=s;const order=await store.create({...s,quantity:1,available:9999}),prepared=(await prepareThroughGateway({order})).candidate;
    window.writeFailure=native?null:'ready';const status=await code(store.prepareAssetSigning(s,prepared));window.writeFailure=null;return status;
  },{s:scope,native});
  assert.equal(status==='UNEXPECTED_SUCCESS',native);const signed=await observe(scope);
  await open(scope);await spaced();history.set();return{scope,bytes:signed};
}
try{
  await runtime.start();await launch();
  const missing=await setup('prewallet-expiry-restart'),original=await rows(missing.scope);assert.equal(original.length,1);
  let count=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.reviewExpiry())),'EXPLICIT_EXPIRY_REVIEW_REQUIRED');assert.equal(fixture.calls.length,count);
  await restart(missing.scope);assert.equal((await review()).status,'expired');assert.deepEqual(await stats(),{native:0,wallet:0});
  const stored=await rows(missing.scope);assert.deepEqual(stored.slice(0,1),original);assert.deepEqual(stored.map(r=>r.phase),['claimed','prewallet-expired']);
  const order=await read(missing.scope);assert.equal(order.revision,2);assert.equal(order.items[0].attempts[0].signature,null);assert.equal(order.items[0].attempts[0].state,'expired');
  count=fixture.calls.length;await restart(missing.scope);assert.equal((await review()).status,'already-recorded');assert.equal(fixture.calls.length,count);
  assert.equal(await page.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true}))),'SEND_NOT_READY');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  report.cases.push('explicit review after full restart retires the missing native result with a null signature and original claim intact; no wallet, send or replacement permission');

  const partial=await setup('prewallet-expiry-partial',{native:true}),partialRows=await rows(partial.scope);loseFailureReply=true;
  assert.equal(await reviewError(),'SUBMISSION_HTTP');loseFailureReply=false;count=fixture.calls.length;await restart(partial.scope);
  assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);assert.deepEqual((await rows(partial.scope)).slice(0,2),partialRows);
  const attempt=await page.evaluate(s=>store.readBuyerAttempt(s,1),partial.scope);assert.equal(attempt.prewallet.status,'expired');assert.equal(attempt.wallet,null);assert.equal(attempt.submission,null);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),partial.scope)).status,'asset-signing-reconciled');assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('saved partial survives lost server reply and both restarts; cached absence evidence closes it without another RPC or native signature');

  const unknown=await setup('prewallet-expiry-unknown'),beforeUnknown=await rows(unknown.scope);await restart(unknown.scope);history.history([]);
  assert.equal((await review()).status,'unknown');assert.deepEqual(await rows(unknown.scope),beforeUnknown);
  history.history([850]);await spaced();assert.equal((await review()).status,'unknown');assert.deepEqual(await rows(unknown.scope),beforeUnknown);
  history.history();await spaced();assert.equal((await review()).status,'expired');assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('empty or short payer history cannot retire; actual complete coverage later closes the same attempt without clearing history');

  for(const fault of ['terminal','event']){
    const item=await setup('prewallet-expiry-abort-'+fault),beforeRows=await rows(item.scope);
    await page.evaluate(fault=>{window.writeFailure=fault==='terminal'?'prewallet-expired':null;window.failProofWrite=fault==='event';},fault);
    assert.notEqual(await reviewError(),'UNEXPECTED_SUCCESS');assert.deepEqual(await rows(item.scope),beforeRows);assert.equal((await read(item.scope)).revision,1);
    count=fixture.calls.length;await restart(item.scope);assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);
  }
  report.cases.push('aborted terminal row or reconcile write rolls back the whole IndexedDB transaction; retained server evidence repairs it after restart');

  const ack=await setup('prewallet-expiry-local-ack');await page.evaluate(()=>window.losePrewalletAck=true);assert.equal(await reviewError(),'LOST_PREWALLET_ACK');
  count=fixture.calls.length;await restart(ack.scope);assert.equal((await review()).status,'already-recorded');assert.equal(fixture.calls.length,count);
  const readback=await setup('prewallet-expiry-readback');await page.evaluate(()=>window.losePrewalletReadback=true);assert.equal(await reviewError(),'ASSET_KEY_MISMATCH');
  count=fixture.calls.length;const beforeStats=await stats();
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),readback.scope)).status,'asset-signing-reconciled');
  assert.equal((await review()).status,'already-recorded');assert.equal(fixture.calls.length,count);assert.deepEqual(await stats(),beforeStats);
  report.cases.push('lost local acknowledgment and terminal custody readback preserve committed retirement; native recovery never re-signs or appends a partial');

  const paused=await setup('prewallet-expiry-pause'),prior=await page.evaluate(s=>store.readPrewalletRecovery(s),paused.scope);
  const oldReport=await page.evaluate(v=>responseTransport.reviewPrewalletExpiry(v),prior.input);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:1}),paused.scope);
  assert.notEqual(await page.evaluate(({s,r})=>code(store.savePrewalletExpiry(s,r)),{s:paused.scope,r:oldReport}),'UNEXPECTED_SUCCESS');
  count=fixture.calls.length;assert.equal((await review()).status,'expired');assert.equal((await read(paused.scope)).paused,true);assert.equal(fixture.calls.length,count);
  const late=await setup('prewallet-expiry-late-partial'),state=await page.evaluate(s=>store.readPrewalletRecovery(s),late.scope);
  const terminal=await page.evaluate(v=>responseTransport.reviewPrewalletExpiry(v),state.input);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),late.scope)).status,'asset-partial-saved');
  assert.notEqual(await page.evaluate(({s,r})=>code(store.savePrewalletExpiry(s,r)),{s:late.scope,r:terminal}),'UNEXPECTED_SUCCESS');
  count=fixture.calls.length;const lateStats=await stats();assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);assert.deepEqual(await stats(),lateStats);
  report.cases.push('pause and late retention reject stale report bindings; restored evidence uses the actual revision and partial while preserving pause');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  history.set(false);fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
