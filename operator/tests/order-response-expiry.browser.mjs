// Disposable Chromium -> HTTPS -> workerd/SQLite. No live RPC, wallets or funds.
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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-response-expiry-fixture-'));
const output=path.resolve('operator/build/buyer-response-expiry-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),history=prewalletExpiryFixture(fixture),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,loseReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const routes=['prepare','check','send','recover','recover-response','review-response-expiry','review-expiry','replace','recover-prewallet','review-prewallet-expiry'];
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(routes.some(r=>req.url==='/api/buyer/'+r)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)}),body=await response.text();
      if(loseReply&&req.url==='/api/buyer/review-response-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable missing-response expiry</title><script type="module" src="/fixture.js"></script>');}
  }catch(e){report.pageErrors.push('bridge:'+e.message);res.writeHead(503);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${server.address().port}`;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:true});
const base={cluster:'devnet',buyer:fixture.policy.owner,machine:fixture.plan.roles.machine,collection:fixture.plan.roles.collection,guard:fixture.plan.roles.guard};
const spaced=()=>new Promise(r=>setTimeout(r,250));
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.openGatewayClient);
}
async function open(scope){await page.evaluate(s=>{window.auditScope=s;openSender(s);openResponseRecovery(s);openPrewalletRecovery(s);},scope);}
async function wallet(scope){await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});}
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const order=s=>page.evaluate(s=>store.read(s),s);
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const state=s=>page.evaluate(s=>store.readBuyerResponseRecovery(s),s);
const review=async()=>{await spaced();return page.evaluate(()=>responseRecovery.reviewExpiry({authorizeExpiryReview:true}));};
const reviewError=async()=>{await spaced();return page.evaluate(()=>code(responseRecovery.reviewExpiry({authorizeExpiryReview:true})));};
const discover=async()=>{await spaced();return page.evaluate(()=>responseRecovery.recoverMissingResponse());};
async function claim(scope){
  await wallet(scope);await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();
  await page.evaluate(()=>{window.discardWalletResponse=true;});
  assert.equal(await page.evaluate(()=>code(client.signOnly(window.costConsent))),'WALLET_RESPONSE_UNKNOWN');
  const signed=await page.evaluate(()=>window.fixtureSignedBytes);assert.ok(signed);await open(scope);
  const pending=await state(scope);assert.equal(pending.status,'wallet-response-unknown');assert.equal(pending.input.walletClaim.version,2);
  return signed;
}
async function setup(id){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);const scope={...base,id};await spaced();
  await page.evaluate(async s=>{window.auditScope=s;const o=await store.create({...s,quantity:1,available:9999});
    await store.prepareAssetSigning(s,(await prepareThroughGateway({order:o})).candidate);},scope);
  const signed=await claim(scope);history.set();return{scope,signed};
}
async function assertClosed(scope){
  const before=fixture.calls.length,currentStats=await stats(),saved=await rows(scope);
  assert.equal((await review()).outcome,'expired');assert.equal((await discover()).outcome,'expired');
  const errors=await page.evaluate(async s=>({send:await code(sender.sendOnce({authorizeDevnetSend:true})),recover:await code(sender.recover()),
    expiry:await code(sender.reviewExpiry({authorizeExpiryReview:true})),replace:await code(sender.prepareReplacement({authorizeReplacement:true})),
    prewallet:await code(prewalletRecovery.recover()),native:(await store.recoverAssetSigning(s)).status}),scope);
  assert.deepEqual(errors,{send:'SEND_NOT_READY',recover:'SAVED_RESPONSE_REQUIRED',expiry:'EXPIRY_NOT_READY',replace:'REPLACEMENT_NOT_READY',prewallet:'PREWALLET_REQUIRED',native:'asset-signing-reconciled'});
  await wallet(scope);assert.equal(await page.evaluate(()=>code(client.quoteCost())),'NOT_READY');
  assert.equal(await page.evaluate(()=>code(client.signOnly(window.costConsent))),'NOT_READY');
  assert.equal(fixture.calls.length,before);assert.deepEqual(await rows(scope),saved);assert.deepEqual(await stats(),currentStats);
}
try{
  await runtime.start();await launch();
  const first=await setup('response-expiry-restart'),original=await rows(first.scope),pending=await state(first.scope);let count=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(responseRecovery.reviewExpiry())),'EXPLICIT_EXPIRY_REVIEW_REQUIRED');assert.equal(fixture.calls.length,count);
  assert.equal((await discover()).status,'unknown');assert.deepEqual(await rows(first.scope),original);
  await restart(first.scope);assert.equal((await review()).status,'expired');assert.deepEqual(await stats(),{native:0,wallet:0});
  const closed=await rows(first.scope);assert.deepEqual(closed.slice(0,3),original);assert.deepEqual(closed.map(r=>r.phase),['claimed','ready','wallet-claimed','response-expired']);
  const retired=await order(first.scope);assert.equal(retired.revision,3);assert.equal(retired.items[0].attempts[0].signature,null);assert.equal(retired.items[0].attempts[0].state,'expired');
  const attempt=await page.evaluate(s=>store.readBuyerAttempt(s,1),first.scope);assert.equal(attempt.wallet.response,null);assert.equal(attempt.wallet.status,'response-expired');assert.equal(attempt.submission,null);assert.equal(attempt.responseExpiry.report.proof.signature,null);
  assert.deepEqual(attempt.wallet.claim,pending.input.walletClaim);count=fixture.calls.length;await restart(first.scope);await assertClosed(first.scope);assert.equal(fixture.calls.length,count);
  assert.equal(await page.evaluate(({s,b,c})=>code(store.saveBuyerResponse(s,{claimId:c,transactionBase64:b})),{s:first.scope,b:first.signed,c:pending.input.walletClaim.claimId}),'RESPONSE_EXPIRED');
  assert.deepEqual(await rows(first.scope),closed);
  report.cases.push('explicit review after full restart preserves native partial, actual wallet claim and cost consent; null-signature terminal blocks all old send, wallet, recovery and replacement paths and rejects late response bytes');

  const lost=await setup('response-expiry-http-lost'),lostRows=await rows(lost.scope);loseReply=true;
  assert.equal(await reviewError(),'SUBMISSION_HTTP');loseReply=false;assert.deepEqual(await rows(lost.scope),lostRows);count=fixture.calls.length;
  await restart(lost.scope);assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);
  report.cases.push('lost HTTP acknowledgment keeps the consumed wallet claim and restores terminal evidence from SQLite after browser and server restart without RPC');

  const unknown=await setup('response-expiry-unknown'),unknownRows=await rows(unknown.scope);history.history([]);
  assert.equal((await review()).status,'unknown');assert.deepEqual(await rows(unknown.scope),unknownRows);
  history.history([850]);assert.equal((await review()).status,'unknown');assert.deepEqual(await rows(unknown.scope),unknownRows);
  history.history();assert.equal((await review()).status,'expired');
  report.cases.push('empty or insufficient payer history preserves the unresolved attempt; complete finalized coverage alone permits retirement');

  for(const fault of ['terminal','event']){
    const item=await setup('response-expiry-abort-'+fault),before=await rows(item.scope);
    await page.evaluate(f=>{window.writeFailure=f==='terminal'?'response-expired':null;window.failProofWrite=f==='event';},fault);
    assert.notEqual(await reviewError(),'UNEXPECTED_SUCCESS');assert.deepEqual(await rows(item.scope),before);assert.equal((await order(item.scope)).revision,2);
    assert.equal((await state(item.scope)).status,'wallet-response-unknown');count=fixture.calls.length;
    await restart(item.scope);assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);
  }
  report.cases.push('strict IndexedDB abort on either terminal report or reconcile event rolls back all rows and the order; server proof repairs after restart');

  const ack=await setup('response-expiry-local-ack');await page.evaluate(()=>{window.loseResponseExpiryAck=true;});
  assert.equal(await reviewError(),'LOST_RESPONSE_EXPIRY_ACK');count=fixture.calls.length;await restart(ack.scope);assert.equal((await review()).status,'already-recorded');assert.equal(fixture.calls.length,count);
  const readback=await setup('response-expiry-readback');await page.evaluate(()=>{window.loseResponseExpiryReadback=true;});
  assert.equal(await reviewError(),'ASSET_KEY_MISMATCH');count=fixture.calls.length;const noMoreSigning=await stats();
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),readback.scope)).status,'asset-signing-reconciled');
  assert.equal((await review()).status,'already-recorded');assert.equal(fixture.calls.length,count);assert.deepEqual(await stats(),noMoreSigning);
  report.cases.push('lost local acknowledgment or post-commit custody readback retains retirement and never re-signs the native transaction');

  const pause=await setup('response-expiry-pause'),pauseState=await state(pause.scope);await spaced();
  const oldReport=await page.evaluate(v=>responseTransport.reviewResponseExpiry(v),pauseState.input);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:2}),pause.scope);
  assert.notEqual(await page.evaluate(({s,r})=>code(store.saveBuyerResponseExpiry(s,r)),{s:pause.scope,r:oldReport}),'UNEXPECTED_SUCCESS');
  count=fixture.calls.length;assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,count);assert.equal((await order(pause.scope)).paused,true);
  await restart(pause.scope);assert.equal((await review()).outcome,'expired');assert.equal((await order(pause.scope)).paused,true);
  report.cases.push('pause invalidates a stale local report; persisted evidence rebinds to the actual revision while retaining pause through restart');

  const late=await setup('response-expiry-late'),lateState=await state(late.scope);await spaced();
  const lateReport=await page.evaluate(v=>responseTransport.reviewResponseExpiry(v),lateState.input);
  await page.evaluate(({s,b,c})=>store.saveBuyerResponse(s,{claimId:c,transactionBase64:b}),{s:late.scope,b:late.signed,c:lateState.input.walletClaim.claimId});
  assert.equal(await page.evaluate(({s,r})=>code(store.saveBuyerResponseExpiry(s,r)),{s:late.scope,r:lateReport}),'MISSING_RESPONSE_REQUIRED');
  count=fixture.calls.length;await spaced();assert.equal(await page.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true}))),'SUBMISSION_HTTP');
  assert.equal(fixture.calls.length,count);await spaced();
  assert.equal((await page.evaluate(()=>sender.reviewExpiry({authorizeExpiryReview:true}))).status,'expired');assert.equal(fixture.calls.length,count);
  assert.equal((await page.evaluate(s=>store.readBuyerSubmission(s),late.scope)).status,'expired');
  await spaced();assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'SUBMISSION_HTTP');assert.equal(fixture.calls.length,count);
  await restart(late.scope);assert.equal((await page.evaluate(()=>sender.reviewExpiry({authorizeExpiryReview:true}))).outcome,'expired');
  report.cases.push('late wallet response before local retirement rejects stale save; server tombstone blocks send and cached explicit signed expiry closes it without RPC or replacement permission');

  const legacy=await setup('response-expiry-legacy');
  await page.evaluate(s=>raw(['signing'],'readwrite',tx=>{const k=[scopeKey(s),0,1,2],r=tx.objectStore('signing').get(k);r.onsuccess=()=>{const row=r.result;delete row.record.costApproval;row.record.version=1;tx.objectStore('signing').put(row,k);};return r;}),legacy.scope);
  const legacyRows=await rows(legacy.scope);await restart(legacy.scope);assert.equal((await review()).status,'expired');assert.deepEqual((await rows(legacy.scope)).slice(0,3),legacyRows);
  assert.equal((await page.evaluate(s=>store.readBuyerResponse(s),legacy.scope)).claim.version,1);
  report.cases.push('legacy version-1 wallet claim retires without inventing modern consent or changing the original claim');

  const second=await setup('response-expiry-second');history.set(false);fixture.receipt(second.signed);fixture.setMode('failure-finalized');assert.equal((await discover()).status,'failed');
  const firstRows=await rows(second.scope);fixture.setGeneration(2);fixture.setMode('normal');await spaced();
  const replacement=await page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  await page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:'10000'}),{s:second.scope,r:replacement});
  await claim(second.scope);history.history([1550,1199]);history.set();assert.equal((await review()).status,'expired');
  await restart(second.scope);assert.equal((await review()).outcome,'expired');assert.deepEqual((await rows(second.scope)).slice(0,firstRows.length),firstRows);
  const attempts=await page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],second.scope);
  assert.equal(attempts[0].submission.failureRecord.evidence.feeLamports,'10000');assert.equal(attempts[1].responseExpiry.status,'expired');assert.equal(attempts[1].wallet.response,null);
  assert.equal(attempts[1].order.items[0].attempts[1].signature,null);await assertClosed(second.scope);
  report.cases.push('second-attempt missing response retires after separate paid-fee acknowledgment and fresh consent; complete first failure history remains readable and unchanged');

  for(const corrupt of ['proof','claim','missing-terminal']){
    const item=await setup('response-expiry-corrupt-'+corrupt);assert.equal((await review()).status,'expired');
    await page.evaluate(({s,corrupt})=>raw(['signing'],'readwrite',tx=>{const k=[scopeKey(s),0,1,corrupt==='claim'?2:6];
      if(corrupt==='missing-terminal')return tx.objectStore('signing').delete(k);
      const r=tx.objectStore('signing').get(k);r.onsuccess=()=>{const row=r.result;if(corrupt==='proof')row.record.report.proof.signature='invented';else row.record.claimId='f'.repeat(64);tx.objectStore('signing').put(row,k);};return r;
    }),{s:item.scope,corrupt});
    count=fixture.calls.length;assert.notEqual(await page.evaluate(s=>code(store.read(s)),item.scope),'UNEXPECTED_SUCCESS');assert.notEqual(await reviewError(),'UNEXPECTED_SUCCESS');assert.equal(fixture.calls.length,count);
  }
  report.cases.push('tampered null-signature proof, substituted wallet claim and missing terminal row all fail closed before network access');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  history.set(false);fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
