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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-prewallet-expiry-replacement-fixture-'));
const output=path.resolve('operator/build/buyer-prewallet-expiry-replacement-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
const history=prewalletExpiryFixture(fixture);
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,loseReplacementReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/recover-prewallet','/api/buyer/review-prewallet-expiry','/api/buyer/replace-prewallet-expiry','/api/buyer/review-expiry','/api/buyer/replace'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      const body=await response.text();
      if(loseReplacementReply&&req.url==='/api/buyer/replace-prewallet-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable unsigned expiry replacement integration</title><script type="module" src="/fixture.js"></script>');}
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
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const read=s=>page.evaluate(s=>store.read(s),s);
const stats=()=>page.evaluate(()=>({native:assetSignAttempts,wallet:walletCalls}));
const replace=()=>page.evaluate(()=>prewalletRecovery.prepareReplacement({authorizeReplacement:true}));
const nativePrepare=(s,r)=>page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true}),{s,r});
const attempts=s=>page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],s);
async function open(scope){await page.evaluate(s=>{window.auditScope=s;openSender(s);openPrewalletRecovery(s);},scope);}
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(scope);}
async function setup(id,{native=false}={}){
  history.set(false);history.history();history.rewrite(undefined);fixture.setGeneration(1);const scope={...base,id};await spaced();
  const status=await page.evaluate(async({s,native})=>{
    window.auditScope=s;const order=await store.create({...s,quantity:1,available:9999}),prepared=(await prepareThroughGateway({order})).candidate;
    window.writeFailure=native?null:'ready';const status=await code(store.prepareAssetSigning(s,prepared));window.writeFailure=null;return status;
  },{s:scope,native});
  assert.equal(status==='UNEXPECTED_SUCCESS',native);await open(scope);await spaced();history.set();return{scope};
}
async function expired(id,native=false){
  const item=await setup(id,{native});assert.equal((await page.evaluate(()=>prewalletRecovery.reviewExpiry({authorizeExpiryReview:true}))).status,'expired');
  history.set(false);fixture.setGeneration(2);return item;
}
async function walletSign(scope){
  await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:scope,secret:[...fixture.owner.secretKey]});
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
}
try{
  await runtime.start();await launch();
  const first=await expired('prewallet-expiry-replacement-lost'),original=await rows(first.scope);await restart(first.scope);
  const before=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement())),'EXPLICIT_REPLACEMENT_REQUIRED');
  assert.notEqual(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'0'}))),'UNEXPECTED_SUCCESS');
  assert.equal(fixture.calls.length,before);
  loseReplacementReply=true;await assert.rejects(replace());loseReplacementReply=false;const savedCalls=fixture.calls.length;await restart(first.scope);
  const next=await replace();assert.equal(next.restored,true);assert.equal(next.record.version,4);assert.equal(next.candidate.orderRevision,2);
  assert.equal(next.previousSignature,null);assert.equal(next.record.prior.proof.signature,null);assert.equal(next.record.acknowledgedFeeLamports,undefined);
  assert.equal(fixture.calls.length,savedCalls);assert.deepEqual(await rows(first.scope),original);assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('explicit unsigned replacement rejects fee fields; lost HTTP reply restores the same reviewed candidate after browser/SQLite restart without signatures or rewriting first history');

  await assert.rejects(page.evaluate(({s,r})=>store.prepareReplacementSigning(s,r),{s:first.scope,r:next}),/EXPLICIT_REPLACEMENT_SIGNING_REQUIRED/);
  const partial=await nativePrepare(first.scope,next);assert.equal(partial.claim.orderRevision,3);assert.equal((await stats()).native,1);
  assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);
  const committed=await page.evaluate(()=>persistedBeforeSign.at(-1));assert.deepEqual(committed.phases,['claimed','prewallet-expired','claimed']);assert.equal(committed.revision,3);
  await restart(first.scope);
  await page.evaluate(({s,secret})=>openGatewayClient(s,secret),{s:first.scope,secret:[...fixture.owner.secretKey]});
  assert.equal(await page.evaluate(()=>code(client.signOnly())),'COST_APPROVAL_REQUIRED');assert.equal((await stats()).wallet,0);
  await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
  const signed=await page.evaluate(s=>store.readBuyerSubmission(s),first.scope);fixture.receipt(signed.input.response.transactionBase64);await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');assert.deepEqual((await rows(first.scope)).slice(0,original.length),original);
  const success=await attempts(first.scope);assert.equal(success[0].prewallet.status,'expired');assert.equal(success[0].wallet,null);assert.equal(success[0].submission,null);
  assert.equal((await read(first.scope)).items[0].attempts[0].signature,null);assert.equal(success[1].submission.status,'verified');
  report.cases.push('actual second claim and prior null-signature proof commit before native sign; fresh cost consent gates wallet access and second success retains the unsigned first history');

  const stale=await expired('prewallet-expiry-replacement-pause',true),candidate=await replace(),staleRows=await rows(stale.scope),staleStats=await stats();
  await page.evaluate(s=>store.append(s,{type:'pause',revision:2}),stale.scope);await assert.rejects(nativePrepare(stale.scope,candidate));assert.deepEqual(await stats(),staleStats);
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  await page.evaluate(s=>store.append(s,{type:'resume',revision:3}),stale.scope);const rpc=fixture.calls.length,rebound=await replace();assert.equal(rebound.candidate.orderRevision,4);assert.equal(fixture.calls.length,rpc);
  const tampered=structuredClone(rebound);tampered.record.prior.evidence.historySha256='0'.repeat(64);await assert.rejects(nativePrepare(stale.scope,tampered));assert.deepEqual(await stats(),staleStats);
  await nativePrepare(stale.scope,rebound);assert.deepEqual((await rows(stale.scope)).slice(0,staleRows.length),staleRows);
  assert.deepEqual(staleRows.map(r=>r.phase),['claimed','ready','prewallet-expired']);await restart(stale.scope);
  assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,1),stale.scope)).prewallet.status,'expired');
  report.cases.push('pause and altered evidence block native preparation; cached candidate rebinds after resume and exact first partial remains readable across restart');

  const abort=await expired('prewallet-expiry-replacement-abort'),abortRows=await rows(abort.scope),prepared=await replace(),count=await stats();
  await page.evaluate(()=>window.writeFailure='claimed');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  assert.deepEqual(await rows(abort.scope),abortRows);assert.deepEqual(await stats(),count);assert.equal((await read(abort.scope)).revision,2);
  await page.evaluate(()=>window.writeFailure='ready');await assert.rejects(nativePrepare(abort.scope,prepared));await page.evaluate(()=>window.writeFailure=null);
  const after=await stats();assert.equal(after.native,count.native+1);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),abort.scope)).status,'asset-partial-saved');assert.deepEqual(await stats(),after);
  report.cases.push('aborted second claim rolls back without native signing; lost ready write recovers only the retained second signature without repeating either attempt');

  await walletSign(abort.scope);const second=await page.evaluate(s=>store.readBuyerSubmission(s),abort.scope);fixture.receipt(second.input.response.transactionBase64);fixture.setMode('failure-finalized');await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'failed');await restart(abort.scope);
  const failures=await attempts(abort.scope);assert.equal(failures[0].prewallet.status,'expired');assert.equal(failures[0].wallet,null);
  assert.equal(failures[1].submission.failureRecord.evidence.feeLamports,'10000');assert.equal((await read(abort.scope)).items[0].attempts[0].signature,null);
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  report.cases.push('second failure retains its actual fee while first remains unsigned and fee-free; both adapters block a third attempt after restart');

  const lost=await expired('prewallet-expiry-replacement-claim-readback'),lostRows=await rows(lost.scope),lostCandidate=await replace(),lostStats=await stats();
  await page.evaluate(()=>window.loseNativeClaimReadback=true);await assert.rejects(nativePrepare(lost.scope,lostCandidate));assert.deepEqual(await stats(),lostStats);
  assert.deepEqual((await rows(lost.scope)).slice(0,lostRows.length),lostRows);assert.equal((await rows(lost.scope)).at(-1).phase,'claimed');await restart(lost.scope);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),lost.scope)).status,'asset-signing-unknown');
  await assert.rejects(nativePrepare(lost.scope,lostCandidate));assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('lost second claim readback prevents native signing and survives restart as unresolved; neither native recovery nor stale replacement approval repeats the claim');

  const unknown=await setup('prewallet-expiry-replacement-unknown'),unknownRows=await rows(unknown.scope),unknownCalls=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');assert.equal(fixture.calls.length,unknownCalls);assert.deepEqual(await rows(unknown.scope),unknownRows);
  const claimed=await setup('prewallet-expiry-replacement-wallet-claimed',{native:true});history.set(false);
  await page.evaluate(()=>window.discardWalletResponse=true);await assert.rejects(walletSign(claimed.scope),/WALLET_RESPONSE_UNKNOWN/);await page.evaluate(()=>window.discardWalletResponse=false);
  const walletRows=await rows(claimed.scope),walletCalls=fixture.calls.length;
  assert.equal(walletRows.at(-1).phase,'wallet-claimed');
  assert.equal(await page.evaluate(()=>code(prewalletRecovery.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');assert.equal(fixture.calls.length,walletCalls);assert.deepEqual(await rows(claimed.scope),walletRows);
  report.cases.push('unknown native state and missing response after an actual wallet claim cannot enter unsigned-expiry replacement or perform extra RPC');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  history.set(false);fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
