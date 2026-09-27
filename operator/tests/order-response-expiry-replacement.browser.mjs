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
import {prewalletExpiryFixture} from './fixtures/buyer-prewallet-expiry.mjs';
import {buyerGatewayRuntime,fixturePolicyPlugin} from './fixtures/buyer-gateway-runtime.mjs';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-response-expiry-replacement-fixture-'));
const output=path.resolve('operator/build/buyer-response-expiry-replacement-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),history=prewalletExpiryFixture(fixture),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,loseReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const routes=['prepare','check','send','recover','recover-response','review-response-expiry','replace-response-expiry','review-expiry','replace','recover-prewallet','review-prewallet-expiry','replace-prewallet-expiry'];
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(routes.some(r=>req.url==='/api/buyer/'+r)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)}),body=await response.text();
      if(loseReply&&req.url==='/api/buyer/replace-response-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable missing-response expiry replacement</title><script type="module" src="/fixture.js"></script>');}
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
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const read=s=>page.evaluate(s=>store.read(s),s);
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const replace=async()=>{await spaced();return page.evaluate(()=>responseRecovery.prepareReplacement({authorizeReplacement:true}));};
const expire=async()=>{await spaced();return page.evaluate(()=>responseRecovery.reviewExpiry({authorizeExpiryReview:true}));};
const nativePrepare=(s,r)=>page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true}),{s,r});
const attempts=s=>page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],s);
async function connect(scope){await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});}
async function walletSign(scope,lost=false){
  await connect(scope);await page.evaluate(v=>window.discardWalletResponse=v,lost);await spaced();
  await page.evaluate(()=>approveFixtureCost());const consent=await page.evaluate(()=>window.costConsent);await spaced();
  const status=await page.evaluate(()=>code(client.signOnly(window.costConsent)));
  assert.equal(status,lost?'WALLET_RESPONSE_UNKNOWN':'UNEXPECTED_SUCCESS');
  return{consent,bytes:lost?await page.evaluate(()=>window.fixtureSignedBytes):null};
}
async function setup(id,{retire=true,legacy=false}={}){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);const scope={...base,id};await spaced();
  await page.evaluate(async s=>{window.auditScope=s;const order=await store.create({...s,quantity:1,available:9999});
    await store.prepareAssetSigning(s,(await prepareThroughGateway({order})).candidate);},scope);
  const signed=await walletSign(scope,true);await open(scope);
  if(legacy)await page.evaluate(s=>raw(['signing'],'readwrite',tx=>{const k=[scopeKey(s),0,1,2],r=tx.objectStore('signing').get(k);
    r.onsuccess=()=>{const row=r.result;delete row.record.costApproval;row.record.version=1;tx.objectStore('signing').put(row,k);};return r;}),scope);
  const original=await rows(scope);
  if(retire){history.set();assert.equal((await expire()).status,'expired');history.set(false);fixture.setGeneration(2);}
  return{scope,...signed,original};
}
async function assertNoThird(){
  const before=fixture.calls.length,current=await stats();
  assert.equal(await page.evaluate(()=>code(responseRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  assert.equal(fixture.calls.length,before);assert.deepEqual(await stats(),current);
}
try{
  await runtime.start();await launch();
  const first=await setup('response-replacement-http'),original=await rows(first.scope);await restart(first.scope);let count=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(responseRecovery.prepareReplacement())),'EXPLICIT_REPLACEMENT_REQUIRED');
  assert.notEqual(await page.evaluate(()=>code(responseRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'0'}))),'UNEXPECTED_SUCCESS');
  assert.equal(fixture.calls.length,count);loseReply=true;await assert.rejects(replace());loseReply=false;count=fixture.calls.length;await restart(first.scope);
  const next=await replace();assert.equal(next.restored,true);assert.equal(next.record.version,5);assert.equal(next.candidate.orderRevision,3);
  assert.equal(next.previousSignature,null);assert.equal(next.record.prior.proof.signature,null);assert.equal(next.record.acknowledgedFeeLamports,undefined);
  assert.deepEqual(next.record.responseExpiry,{request:original[1].record,walletClaim:original[2].record});
  assert.equal(fixture.calls.length,count);assert.deepEqual(await rows(first.scope),original);assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('explicit replacement retains the actual request, wallet claim and original cost consent; lost HTTP reply restores one v5 candidate after browser/SQLite restart without RPC or signing');

  await assert.rejects(page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r),{s:first.scope,r:next}),/EXPLICIT_REPLACEMENT_SIGNING_REQUIRED/);
  const partial=await nativePrepare(first.scope,next);assert.equal(partial.claim.orderRevision,4);assert.equal((await stats()).native,1);
  assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);
  const committed=await page.evaluate(()=>persistedBeforeSign.at(-1));assert.deepEqual(committed.phases,['claimed','ready','wallet-claimed','response-expired','claimed']);assert.equal(committed.revision,4);
  await restart(first.scope);await connect(first.scope);
  assert.equal(await page.evaluate(()=>code(client.signOnly())),'COST_APPROVAL_REQUIRED');
  await spaced();await page.evaluate(()=>approveFixtureCost());
  assert.notEqual(await page.evaluate(c=>code(client.signOnly(c)),first.consent),'UNEXPECTED_SUCCESS');assert.equal((await stats()).wallet,0);
  await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
  const signed=await page.evaluate(s=>store.readBuyerSubmission(s),first.scope);fixture.receipt(signed.input.response.transactionBase64);await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);
  const success=await attempts(first.scope);assert.equal(success[0].wallet.response,null);assert.equal(success[0].responseExpiry.status,'expired');
  assert.equal(success[0].submission,null);assert.equal(success[1].submission.status,'verified');
  assert.deepEqual(success[0].wallet.claim,original[2].record);await assertNoThird();
  report.cases.push('second intent commits before native signing, old consent cannot invoke a wallet, and fresh consent plus observed second success preserve all first-attempt evidence');

  const paused=await setup('response-replacement-pause'),candidate=await replace(),priorRows=await rows(paused.scope),priorStats=await stats();
  await page.evaluate(s=>store.append(s,{type:'pause',revision:3}),paused.scope);await assert.rejects(nativePrepare(paused.scope,candidate));
  assert.equal(await page.evaluate(()=>code(responseRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  await page.evaluate(s=>store.append(s,{type:'resume',revision:4}),paused.scope);count=fixture.calls.length;
  const rebound=await replace();assert.equal(rebound.candidate.orderRevision,5);assert.equal(fixture.calls.length,count);
  for(const change of ['claim','cost','request','proof']){
    const altered=structuredClone(rebound);
    if(change==='claim')altered.record.responseExpiry.walletClaim.claimId='0'.repeat(64);
    if(change==='cost')altered.record.responseExpiry.walletClaim.costApproval.maxTotalLamports='1';
    if(change==='request')altered.record.responseExpiry.request.transactionBase64='changed';
    if(change==='proof')altered.record.prior.proof.signature='invented';
    await assert.rejects(nativePrepare(paused.scope,altered));
  }
  assert.deepEqual(await stats(),priorStats);await nativePrepare(paused.scope,rebound);await restart(paused.scope);
  assert.deepEqual((await rows(paused.scope)).slice(0,priorRows.length),priorRows);
  const closedFirst=await page.evaluate(s=>store.readBuyerAttempt(s,1),paused.scope);assert.deepEqual(closedFirst.wallet.claim,priorRows[2].record);
  report.cases.push('pause blocks preparation, resumed cached candidate binds the current revision, and altered wallet claim, cost, partial or null proof fail before any native signature');

  const abort=await setup('response-replacement-abort'),abortRows=await rows(abort.scope),prepared=await replace(),beforeNative=await stats();
  await page.evaluate(()=>window.writeFailure='claimed');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  assert.deepEqual(await rows(abort.scope),abortRows);assert.deepEqual(await stats(),beforeNative);assert.equal((await read(abort.scope)).revision,3);
  await page.evaluate(()=>window.writeFailure='ready');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  const afterNative=await stats();assert.equal(afterNative.native,beforeNative.native+1);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),abort.scope)).status,'asset-partial-saved');assert.deepEqual(await stats(),afterNative);
  report.cases.push('failed second-claim commit rolls back without signing; lost partial write recovers only the already produced second signature');

  await walletSign(abort.scope);const failed=await page.evaluate(s=>store.readBuyerSubmission(s),abort.scope);fixture.receipt(failed.input.response.transactionBase64);fixture.setMode('failure-finalized');await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'failed');await restart(abort.scope);
  const failures=await attempts(abort.scope);assert.equal(failures[0].wallet.response,null);assert.equal(failures[1].submission.failureRecord.evidence.feeLamports,'10000');
  assert.deepEqual((await rows(abort.scope)).slice(0,abortRows.length),abortRows);await assertNoThird();
  report.cases.push('second failure records its actual fee, retains first missing-response retirement and forbids a third attempt through every replacement controller');

  const lost=await setup('response-replacement-readback'),lostRows=await rows(lost.scope),lostCandidate=await replace(),lostStats=await stats();
  await page.evaluate(()=>window.loseNativeClaimReadback=true);await assert.rejects(nativePrepare(lost.scope,lostCandidate));assert.deepEqual(await stats(),lostStats);
  assert.deepEqual((await rows(lost.scope)).slice(0,lostRows.length),lostRows);await restart(lost.scope);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),lost.scope)).status,'asset-signing-unknown');
  await assert.rejects(nativePrepare(lost.scope,lostCandidate));await assertNoThird();assert.deepEqual(await stats(),{native:0,wallet:0});
  history.history([1550,1199]);history.set();await spaced();assert.equal((await page.evaluate(()=>prewalletRecovery.reviewExpiry({authorizeExpiryReview:true}))).status,'expired');
  await restart(lost.scope);assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,2),lost.scope)).prewallet.status,'expired');
  assert.deepEqual((await rows(lost.scope)).slice(0,lostRows.length),lostRows);await assertNoThird();
  report.cases.push('lost second-claim readback survives restart without signing; later second prewallet expiry preserves v5 provenance and cannot create attempt three');

  const missing=await setup('response-replacement-second-missing'),missingRows=await rows(missing.scope),missingCandidate=await replace();
  await nativePrepare(missing.scope,missingCandidate);await walletSign(missing.scope,true);history.history([1550,1199]);history.set();
  assert.equal((await expire()).status,'expired');await restart(missing.scope);assert.equal((await expire()).outcome,'expired');
  const missingAttempts=await attempts(missing.scope);assert.equal(missingAttempts[1].wallet.response,null);assert.equal(missingAttempts[1].responseExpiry.status,'expired');
  assert.notEqual(missingAttempts[0].wallet.claim.claimId,missingAttempts[1].wallet.claim.claimId);
  assert.notEqual(missingAttempts[0].wallet.claim.costApproval.quote.quoteId,missingAttempts[1].wallet.claim.costApproval.quote.quoteId);
  assert.deepEqual((await rows(missing.scope)).slice(0,missingRows.length),missingRows);await assertNoThird();
  report.cases.push('second lost wallet response expires under the replacement anchor while both genuine wallet claims and distinct cost approvals remain intact');

  const legacy=await setup('response-replacement-legacy',{legacy:true}),legacyRows=await rows(legacy.scope),legacyCandidate=await replace();
  assert.equal(legacyCandidate.record.responseExpiry.walletClaim.version,1);assert.equal(legacyCandidate.record.responseExpiry.walletClaim.costApproval,undefined);
  await nativePrepare(legacy.scope,legacyCandidate);await restart(legacy.scope);assert.deepEqual((await rows(legacy.scope)).slice(0,legacyRows.length),legacyRows);
  await connect(legacy.scope);assert.equal(await page.evaluate(()=>code(client.signOnly())),'COST_APPROVAL_REQUIRED');assert.equal((await stats()).wallet,0);
  report.cases.push('legacy first wallet claim retains its original schema without invented costs; second wallet signing still requires new modern cost consent');

  const unknown=await setup('response-replacement-unresolved',{retire:false}),unknownRows=await rows(unknown.scope);count=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(responseRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(fixture.calls.length,count);assert.deepEqual(await rows(unknown.scope),unknownRows);
  history.set();assert.equal((await expire()).status,'expired');history.set(false);fixture.setGeneration(2);const oldRows=await rows(unknown.scope),oldClaim=oldRows[2].record.claimId;
  const retry=await replace();await nativePrepare(unknown.scope,retry);count=fixture.calls.length;
  assert.notEqual(await page.evaluate(({s,b,c})=>code(store.saveBuyerResponse(s,{claimId:c,transactionBase64:b})),{s:unknown.scope,b:unknown.bytes,c:oldClaim}),'UNEXPECTED_SUCCESS');
  assert.deepEqual((await rows(unknown.scope)).slice(0,oldRows.length),oldRows);assert.equal(fixture.calls.length,count);
  report.cases.push('unretired wallet uncertainty cannot request replacement, and a late first-wallet callback after preparing attempt two cannot reopen or rewrite the expired attempt');

  for(const corrupt of ['source-claim','replacement-claim','missing-terminal']){
    const item=await setup('response-replacement-corrupt-'+corrupt),record=await replace();await nativePrepare(item.scope,record);
    await page.evaluate(({s,corrupt})=>raw(['signing'],'readwrite',tx=>{
      const k=corrupt==='replacement-claim'?[scopeKey(s),0,2,0]:[scopeKey(s),0,1,corrupt==='missing-terminal'?6:2];
      if(corrupt==='missing-terminal')return tx.objectStore('signing').delete(k);
      const r=tx.objectStore('signing').get(k);r.onsuccess=()=>{const row=r.result;
        if(corrupt==='source-claim')row.record.claimId='f'.repeat(64);else row.replacement.responseExpiry.walletClaim.claimId='f'.repeat(64);
        tx.objectStore('signing').put(row,k);};return r;
    }),{s:item.scope,corrupt});count=fixture.calls.length;
    assert.notEqual(await page.evaluate(s=>code(store.read(s)),item.scope),'UNEXPECTED_SUCCESS');assert.equal(fixture.calls.length,count);
  }
  report.cases.push('mutated first or retained replacement wallet claim and missing first terminal row all fail closed during durable history replay');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  history.set(false);fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
