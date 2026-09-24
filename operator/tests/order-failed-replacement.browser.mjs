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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-failed-replacement-fixture-'));
const output=path.resolve('operator/build/buyer-failed-replacement-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,alter=false,loseReply=false,loseExpiryReply=false,loseReplacementReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/review-expiry','/api/buyer/replace'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      let body=await response.text();if(alter&&response.status===200){const value=JSON.parse(body);value.report.orderSha256='0'.repeat(64);body=JSON.stringify(value);}
      if(loseReply&&req.url==='/api/buyer/send'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      if(loseExpiryReply&&req.url==='/api/buyer/review-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      if(loseReplacementReply&&req.url==='/api/buyer/replace'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
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
async function open(scope,secret=fixture.owner.secretKey){return page.evaluate(({scope,secret})=>openGatewayClient(scope,secret),{scope,secret:[...secret]});}
async function setup(id,buyer=fixture.owner){
  const scope={...base,id,buyer:buyer.publicKey.toBase58()};
  await spaced();
  await page.evaluate(async({scope,block,owner})=>{window.auditScope=scope;const order=await store.create({...scope,quantity:1,available:9999});
    const prepared=scope.buyer===owner?(await prepareThroughGateway({order})).candidate:candidate(order,block);
    await store.prepareAssetSigning(scope,prepared);},{scope,block,owner:fixture.policy.owner});
  await spaced();
  await open(scope,buyer.secretKey);
  if(scope.buyer===fixture.policy.owner){await page.evaluate(()=>approveFixtureCost());await spaced();}
  return scope;
}
const failure=()=>page.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true})));
const send=()=>page.evaluate(()=>sender.sendOnce({authorizeDevnetSend:true}));
const recover=()=>page.evaluate(()=>sender.recover());
const review=()=>page.evaluate(()=>sender.reviewExpiry({authorizeExpiryReview:true}));
const reviewFailure=()=>page.evaluate(()=>code(sender.reviewExpiry({authorizeExpiryReview:true})));
const sends=()=>fixture.calls.filter(c=>c.method==='sendTransaction').length;
async function signed(id){await spaced();const scope=await setup(id);await page.evaluate(()=>client.signOnly(window.costConsent));await page.evaluate(s=>openSender(s),scope);await spaced();return scope;}
const count=()=>page.evaluate(()=>walletCalls);
const spaced=()=>new Promise(r=>setTimeout(r,250));
const replace=()=>page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
const oldRows=scope=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s),0,1],[scopeKey(s),0,1,[]]))),scope);
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>{window.auditScope=s;openSender(s);},scope);}
async function failed(id,consume=false){
  fixture.setGeneration(1);fixture.setMode('normal');const scope=await signed(id);
  if(consume){assert.equal((await send()).status,'accepted');await spaced();}
  else fixture.receipt(await page.evaluate(s=>store.readBuyerResponse(s).then(v=>v.response.transactionBase64),scope));
  fixture.setMode('failure-finalized');assert.equal((await recover()).status,'failed');
  fixture.setMode('normal');fixture.setGeneration(2);await spaced();return scope;
}
async function native(scope,prepared){return page.evaluate(({s,r})=>{window.auditScope=s;return store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:'10000'});},{s:scope,r:prepared});}
try{
  await runtime.start();await launch();const scope=await failed('failed-replace-linked',true),original=await oldRows(scope);
  const first=await page.evaluate(s=>store.readBuyerAttempt(s,1),scope),oldConsent=await page.evaluate(()=>window.costConsent);
  const calls=fixture.calls.length,nativeBefore=await page.evaluate(()=>assetSignAttempts),walletBefore=await count();
  for(const fee of [undefined,'9999',10000])assert.equal(await page.evaluate(fee=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:fee})),fee),'PAID_FEE_ACKNOWLEDGMENT_REQUIRED');
  assert.equal(fixture.calls.length,calls);
  loseReplacementReply=true;assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'SUBMISSION_HTTP');loseReplacementReply=false;
  assert.equal((await page.evaluate(s=>store.read(s),scope)).items[0].attempts.length,1);
  assert.equal(await page.evaluate(()=>assetSignAttempts),nativeBefore);assert.equal(await count(),walletBefore);
  await restart(scope);const afterCommit=fixture.calls.length,prepared=await replace();assert.equal(prepared.restored,true);assert.equal(fixture.calls.length,afterCommit);
  assert.equal(prepared.record.version,2);assert.equal(prepared.record.acknowledgedFeeLamports,'10000');assert.equal(prepared.record.prior.evidence.feeLamports,'10000');
  assert.deepEqual(await oldRows(scope),original);
  for(const fee of [undefined,'9999'])assert.equal(await page.evaluate(({s,r,fee})=>code(store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:fee})),{s:scope,r:prepared,fee}),'PAID_FEE_ACKNOWLEDGMENT_REQUIRED');
  const altered=structuredClone(prepared);altered.record.prior.evidence.feeLamports='9999';await assert.rejects(native(scope,altered));
  assert.equal(await page.evaluate(()=>assetSignAttempts),0);assert.equal(await count(),0);assert.equal(fixture.calls.length,afterCommit);
  report.cases.push('paid fee must be acknowledged before preparation and native signing; lost HTTP reply restores identical SQLite bytes after browser/server restart without changing first history');

  const revision=(await page.evaluate(s=>store.read(s),scope)).revision;
  await page.evaluate(async({s,revision})=>{await store.append(s,{type:'pause',revision});await store.append(s,{type:'resume',revision:revision+1});},{s:scope,revision});
  await assert.rejects(native(scope,prepared));const rebound=await replace();assert.deepEqual(rebound.record,prepared.record);assert.equal(fixture.calls.length,afterCommit);
  const partial=await native(scope,rebound);assert.equal(partial.claim.attempt,2);assert.notEqual(partial.request.transactionBase64,first.signing.request.transactionBase64);
  assert.deepEqual(await oldRows(scope),original);await restart(scope);assert.deepEqual(await page.evaluate(s=>store.readAssetSigning(s),scope),partial);
  await open(scope);assert.notEqual(await page.evaluate(consent=>code(client.signOnly(consent)),oldConsent),'UNEXPECTED_SUCCESS');assert.equal(await count(),0);
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));assert.equal(await count(),1);
  await page.evaluate(s=>openSender(s),scope);await spaced();loseReply=true;assert.equal(await failure(),'SUBMISSION_HTTP');loseReply=false;
  const sent=sends();await restart(scope);assert.equal(await failure(),'SEND_NOT_READY');await spaced();assert.equal((await recover()).status,'verified');
  assert.deepEqual((await page.evaluate(s=>store.read(s),scope)).items[0].attempts.map(a=>a.state),['failed','verified']);
  assert.deepEqual(await oldRows(scope),original);const savedFirst=await page.evaluate(s=>store.readBuyerAttempt(s,1),scope);
  assert.deepEqual(savedFirst.submission.failureRecord,first.submission.failureRecord);assert.equal(savedFirst.wallet.response.transactionBase64,first.wallet.response.transactionBase64);
  assert.equal(sends(),sent);assert.equal(await count(),0);
  report.cases.push('stale preparation cannot sign; rebound template needs fresh wallet cost consent, lost second send reply recovers success and retains first paid failure');

  const abort=await failed('failed-replace-abort'),abortRows=await oldRows(abort),abortReport=await replace(),signs=await page.evaluate(()=>assetSignAttempts);
  await page.evaluate(()=>window.writeFailure='claimed');await assert.rejects(native(abort,abortReport));
  assert.equal(await page.evaluate(()=>assetSignAttempts),signs);assert.equal((await page.evaluate(s=>store.read(s),abort)).items[0].attempts.length,1);
  assert.deepEqual(await oldRows(abort),abortRows);await page.evaluate(()=>window.writeFailure='ready');await assert.rejects(native(abort,abortReport));
  await page.evaluate(()=>window.writeFailure=null);const beforeNativeRecovery=fixture.calls.length,beforeWalletRecovery=await count();
  const restoredNative=await page.evaluate(s=>store.recoverAssetSigning(s),abort);assert.equal(restoredNative.status,'asset-partial-saved');
  assert.equal(restoredNative.claim.attempt,2);assert.deepEqual(await oldRows(abort),abortRows);
  assert.equal(fixture.calls.length,beforeNativeRecovery);assert.equal(await count(),beforeWalletRecovery);
  assert.equal(await page.evaluate(()=>assetSignAttempts),signs+1);
  report.cases.push('aborted second native intent creates no signature; later ready-write abort recovers the original result with no re-sign, wallet or RPC while preserving first paid failure and replacement provenance');

  const ambiguous=await failed('failed-replace-unknown'),ambiguousRows=await oldRows(ambiguous),ambiguousReport=await replace();
  await page.evaluate(()=>window.writeFailure='ready');await assert.rejects(native(ambiguous,ambiguousReport));
  await restart(ambiguous);assert.equal((await page.evaluate(s=>store.readAssetSigning(s),ambiguous)).status,'asset-signing-unknown');
  await assert.rejects(native(ambiguous,ambiguousReport));assert.equal(await page.evaluate(()=>assetSignAttempts),0);assert.deepEqual(await oldRows(ambiguous),ambiguousRows);
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  report.cases.push('lost second native result keeps consumed intent across restart and cannot reuse the first failure to sign again');

  const twice=await failed('failed-replace-twice'),twiceRows=await oldRows(twice);await native(twice,await replace());await open(twice);
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));await page.evaluate(s=>openSender(s),twice);
  fixture.receipt(await page.evaluate(s=>store.readBuyerResponse(s).then(v=>v.response.transactionBase64),twice));fixture.setMode('failure-finalized');await spaced();assert.equal((await recover()).status,'failed');
  await restart(twice);const afterSecond=fixture.calls.length;
  assert.deepEqual((await page.evaluate(s=>store.read(s),twice)).items[0].attempts.map(a=>a.state),['failed','failed']);
  for(const n of [1,2])assert.equal((await page.evaluate(({s,n})=>store.readBuyerAttempt(s,n),{s:twice,n})).submission.failureRecord.evidence.feeLamports,'10000');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  assert.equal(await failure(),'SEND_NOT_READY');assert.deepEqual(await oldRows(twice),twiceRows);assert.equal(fixture.calls.length,afterSecond);
  report.cases.push('second finalized failure retains both paid fees and signatures after restart with no third attempt or resend');

  const expires=await failed('failed-replace-expired'),expiryRows=await oldRows(expires);await native(expires,await replace());await open(expires);
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));await page.evaluate(s=>openSender(s),expires);
  fixture.setMode('expiry-clear');await spaced();assert.equal((await review()).status,'expired');await restart(expires);const afterExpiry=fixture.calls.length;
  assert.deepEqual((await page.evaluate(s=>store.read(s),expires)).items[0].attempts.map(a=>a.state),['failed','expired']);
  assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,1),expires)).submission.failureRecord.evidence.feeLamports,'10000');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  assert.deepEqual(await oldRows(expires),expiryRows);assert.equal(fixture.calls.length,afterExpiry);assert.equal(sends(),sent);
  report.cases.push('second expiry keeps the first paid failure separate and readable without a third attempt after full restart');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=sends();report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
