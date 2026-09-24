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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-response-recovery-fixture-'));
const output=path.resolve('operator/build/buyer-response-recovery-chromium');await mkdir(output,{recursive:true});
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
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/recover-response','/api/buyer/review-expiry','/api/buyer/replace'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      const body=await response.text();
      if(loseFailureReply&&req.url==='/api/buyer/recover-response'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
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
const recover=()=>page.evaluate(()=>sender.recover());
const sends=()=>fixture.calls.filter(c=>c.method==='sendTransaction').length;
const count=()=>page.evaluate(()=>walletCalls);
const spaced=()=>new Promise(r=>setTimeout(r,250));
const oldRows=scope=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s),0,1],[scopeKey(s),0,1,[]]))),scope);
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>{window.auditScope=s;openSender(s);openResponseRecovery(s);},scope);}
const discover=()=>page.evaluate(()=>responseRecovery.recoverMissingResponse());
const discoverError=()=>page.evaluate(()=>code(responseRecovery.recoverMissingResponse()));
async function lostResponse(id,{observe=true}={}){
  fixture.setGeneration(1);fixture.setMode('normal');const scope=await setup(id);
  await page.evaluate(()=>{window.discardWalletResponse=true;});
  assert.notEqual(await page.evaluate(()=>code(client.signOnly(window.costConsent))),'UNEXPECTED_SUCCESS');
  const bytes=await page.evaluate(()=>window.fixtureSignedBytes);assert.ok(bytes);
  if(observe)fixture.receipt(bytes);
  await page.evaluate(s=>{window.discardWalletResponse=false;openSender(s);openResponseRecovery(s);},scope);await spaced();
  const state=await page.evaluate(s=>store.readBuyerResponse(s),scope);assert.equal(state.status,'wallet-response-unknown');assert.equal(state.response,null);
  return{scope,bytes};
}
try{
  await runtime.start();await launch();const first=await lostResponse('response-restart');const original=await oldRows(first.scope);
  await restart(first.scope);const found=await discover();assert.equal(found.status,'verified');assert.equal(await count(),0);
  const saved=await page.evaluate(s=>store.readBuyerSubmission(s),first.scope);assert.equal(saved.status,'verified');assert.equal(saved.sendClaim,null);
  assert.equal(saved.input.response.transactionBase64,first.bytes);assert.deepEqual((await oldRows(first.scope)).slice(0,3),original);
  const before=fixture.calls.length;await restart(first.scope);assert.equal((await discover()).status,'already-recorded');assert.equal(await failure(),'SEND_NOT_READY');assert.equal(fixture.calls.length,before);
  report.cases.push('lost wallet response survives full browser restart; exact chain bytes and verified outcome commit together with no new wallet call or send');

  const absent=await lostResponse('response-empty',{observe:false});let result=await discover();assert.equal(result.status,'unknown');assert.equal(result.response,undefined);
  assert.equal((await page.evaluate(s=>store.readBuyerResponse(s),absent.scope)).response,null);assert.equal(await failure(),'SEND_NOT_READY');
  fixture.receipt(absent.bytes);fixture.setMode('pending');await spaced();assert.equal((await discover()).status,'unknown');
  fixture.setMode('normal');await spaced();assert.equal((await discover()).status,'verified');
  report.cases.push('empty and nonfinalized history keep the wallet claim consumed and expose no response bytes; later positive proof closes the attempt');

  const failed=await lostResponse('response-failed');fixture.setMode('failure-finalized');loseFailureReply=true;
  assert.equal(await discoverError(),'SUBMISSION_HTTP');loseFailureReply=false;const countAfter=fixture.calls.length;
  await restart(failed.scope);assert.equal((await discover()).status,'failed');assert.equal(fixture.calls.length,countAfter);
  const failureState=await page.evaluate(s=>store.readBuyerSubmission(s),failed.scope);assert.equal(failureState.status,'failed');assert.equal(failureState.failureRecord.evidence.feeLamports,'10000');assert.equal(failureState.sendClaim,null);
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'PAID_FEE_ACKNOWLEDGMENT_REQUIRED');
  report.cases.push('lost gateway reply restores exact response plus paid failure atomically from SQLite; replacement still requires the paid-fee acknowledgment');

  for(const phase of ['buyer-response','failure-reviewed']){
    const item=await lostResponse('response-abort-'+phase);fixture.setMode('failure-finalized');const rows=await oldRows(item.scope);
    await page.evaluate(p=>{window.writeFailure=p;},phase);assert.notEqual(await discoverError(),'UNEXPECTED_SUCCESS');
    assert.deepEqual(await oldRows(item.scope),rows);assert.equal((await page.evaluate(s=>store.read(s),item.scope)).revision,2);
    assert.equal((await page.evaluate(s=>store.readBuyerResponse(s),item.scope)).response,null);assert.equal(await failure(),'SEND_NOT_READY');
    const rpc=fixture.calls.length;await restart(item.scope);assert.equal((await discover()).status,'failed');assert.equal(fixture.calls.length,rpc);
  }
  report.cases.push('IndexedDB failure on either response or terminal-fee row rolls back both events and every row; retained server proof repairs the attempt after restart');

  const ack=await lostResponse('response-local-ack');await page.evaluate(()=>{window.loseResponseRecoveryAck=true;});
  assert.equal(await discoverError(),'LOST_RESPONSE_RECOVERY_ACK');const ackCalls=fixture.calls.length;
  await restart(ack.scope);assert.equal((await discover()).status,'already-recorded');assert.equal(fixture.calls.length,ackCalls);assert.equal(await count(),0);
  report.cases.push('lost local commit acknowledgment restores the terminal outcome without repeating HTTP, wallet invocation or native signing');

  const stale=await lostResponse('response-stale');fixture.setMode('hold');let entered;const ready=new Promise(r=>entered=r);fixture.onRequest(()=>entered());
  const running=discoverError();await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('discovery did not reach RPC')),10000);ready.finally(()=>clearTimeout(timer));})]);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:2}),stale.scope);fixture.setMode('normal');fixture.onRequest(null);fixture.release();
  assert.notEqual(await running,'UNEXPECTED_SUCCESS');assert.equal((await page.evaluate(s=>store.readBuyerResponse(s),stale.scope)).response,null);
  const staleCalls=fixture.calls.length;assert.equal((await discover()).status,'verified');assert.equal(fixture.calls.length,staleCalls);
  assert.equal((await page.evaluate(s=>store.read(s),stale.scope)).paused,true);
  report.cases.push('pause during discovery rejects the stale local report and cached proof rebinds to the new revision without clearing pause');

  const late=await lostResponse('response-late-wallet');const missing=await page.evaluate(s=>store.readBuyerResponseRecovery(s),late.scope);
  const terminal=await page.evaluate(input=>responseTransport.recoverResponse(input),missing.input);
  await page.evaluate(({s,b,c})=>store.saveBuyerResponse(s,{claimId:c,transactionBase64:b}),{s:late.scope,b:late.bytes,c:missing.input.walletClaim.claimId});
  assert.notEqual(await page.evaluate(({s,r})=>code(store.saveRecoveredBuyerResponse(s,r)),{s:late.scope,r:terminal}),'UNEXPECTED_SUCCESS');
  const lateCalls=fixture.calls.length;assert.equal((await recover()).status,'verified');assert.equal(fixture.calls.length,lateCalls);
  const revision=(await page.evaluate(s=>store.read(s),late.scope)).revision;
  await page.evaluate(({s,b,c})=>store.saveBuyerResponse(s,{claimId:c,transactionBase64:b}),{s:late.scope,b:late.bytes,c:missing.input.walletClaim.claimId});
  assert.equal((await page.evaluate(s=>store.read(s),late.scope)).revision,revision);assert.equal(await failure(),'SEND_NOT_READY');
  report.cases.push('late wallet callback is preserved; stale atomic recovery cannot overwrite it, cached ordinary recovery closes it, duplicate bytes add no events');

  // Continue the previously discovered paid failure using separate fee acknowledgment and fresh consent.
  await restart(failed.scope);fixture.setGeneration(2);fixture.setMode('normal');const firstRows=await oldRows(failed.scope);
  const replacement=await page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  await page.evaluate(({s,r})=>{window.auditScope=s;return store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:'10000'});},{s:failed.scope,r:replacement});
  await open(failed.scope);await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>{window.discardWalletResponse=true;});
  assert.notEqual(await page.evaluate(()=>code(client.signOnly(window.costConsent))),'UNEXPECTED_SUCCESS');
  fixture.receipt(await page.evaluate(()=>window.fixtureSignedBytes));await page.evaluate(s=>openResponseRecovery(s),failed.scope);await spaced();assert.equal((await discover()).status,'verified');
  await restart(failed.scope);assert.equal((await discover()).outcome,'verified');assert.deepEqual(await oldRows(failed.scope),firstRows);
  const history=await page.evaluate(s=>Promise.all([store.readBuyerAttempt(s,1),store.readBuyerAttempt(s,2)]),failed.scope);
  assert.equal(history[0].submission.failureRecord.evidence.feeLamports,'10000');assert.equal(history[1].submission.status,'verified');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  report.cases.push('second missing response recovers after acknowledged paid failure with fresh consent, retaining all first-attempt rows and fee evidence across restart');
  assert.equal(sends(),0);assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=sends();report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
