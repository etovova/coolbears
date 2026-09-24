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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-failure-recovery-fixture-'));
const output=path.resolve('operator/build/buyer-failure-recovery-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,alter=false,loseReply=false,loseExpiryReply=false,loseReplacementReply=false,loseFailureReply=false,context,page;
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
      if(loseFailureReply&&req.url==='/api/buyer/recover'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
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
const replace=()=>page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true}));
const oldRows=scope=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s),0,1],[scopeKey(s),0,1,[]]))),scope);
async function restart(scope){await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>{window.auditScope=s;openSender(s);},scope);}
async function expired(id,consume=false){
  fixture.setGeneration(1);fixture.setMode('normal');const scope=await signed(id);
  if(consume){fixture.setMode('fee-rise');assert.equal(await failure(),'SUBMISSION_HTTP');await spaced();}
  fixture.setMode('expiry-clear');assert.equal((await review()).status,'expired');
  fixture.setMode('normal');fixture.setGeneration(2);await spaced();return scope;
}
async function native(scope,prepared){return page.evaluate(({s,r})=>{window.auditScope=s;return store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true});},{s:scope,r:prepared});}
const recoveryFailure=()=>page.evaluate(()=>code(sender.recover()));
async function observed(id){
  fixture.setGeneration(1);fixture.setMode('normal');const scope=await signed(id);
  fixture.receipt(await page.evaluate(s=>store.readBuyerResponse(s).then(v=>v.response.transactionBase64),scope));
  fixture.setMode('failure-finalized');return scope;
}
try{
  await runtime.start();await launch();const scope=await signed('failure-linked');assert.equal((await send()).status,'accepted');
  const original=await oldRows(scope),bytes=await page.evaluate(s=>store.readBuyerResponse(s).then(v=>v.response.transactionBase64),scope);
  await spaced();fixture.setMode('failure-finalized');const failed=await recover();assert.equal(failed.status,'failed');assert.equal(failed.feeLamports,'10000');assert.equal(failed.retryAuthorized,false);
  const saved=await page.evaluate(s=>store.readBuyerSubmission(s),scope);assert.equal(saved.status,'failed');assert.ok(saved.sendClaim);assert.equal(saved.failureRecord.evidence.feeLamports,'10000');
  assert.deepEqual((await oldRows(scope)).slice(0,-1),original);assert.equal(saved.input.response.transactionBase64,bytes);
  await restart(scope);const before=fixture.calls.length,restored=await recover();assert.equal(restored.status,'already-recorded');assert.equal(restored.outcome,'failed');assert.equal(restored.feeLamports,'10000');
  assert.equal(await failure(),'SEND_NOT_READY');assert.equal(await reviewFailure(),'EXPIRY_NOT_READY');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.equal(fixture.calls.length,before);assert.equal(await count(),0);assert.equal(sends(),1);
  report.cases.push('exact finalized failure and paid fee close a sent attempt; full browser/server restart preserves response, approval, native/wallet/send claims and makes no new wallet/send/RPC call');

  const incomplete=await observed('failure-incomplete');
  for(const mode of ['failure-no-fee','failure-asset','failure-pending']){
    fixture.setMode(mode);await spaced();assert.equal((await recover()).status,'unknown');assert.equal((await page.evaluate(s=>store.read(s),incomplete)).revision,3);
    assert.equal((await page.evaluate(s=>store.readBuyerSubmission(s),incomplete)).failureRecord,null);
  }
  fixture.setMode('failure-finalized');await spaced();assert.equal((await recover()).status,'failed');
  report.cases.push('incomplete fee, observed asset and pending status retain unknown browser history until complete finalized failure evidence is available');

  const atomic=await observed('failure-atomic');await page.evaluate(()=>window.writeFailure='failure-reviewed');
  assert.notEqual(await recoveryFailure(),'UNEXPECTED_SUCCESS');assert.equal((await page.evaluate(s=>store.read(s),atomic)).revision,3);
  const committedCalls=fixture.calls.length;await page.evaluate(()=>{window.writeFailure=null;window.loseFailureAck=true;});
  assert.equal(await recoveryFailure(),'LOST_FAILURE_ACK');assert.equal(fixture.calls.length,committedCalls);
  await restart(atomic);assert.equal((await recover()).outcome,'failed');assert.equal((await page.evaluate(s=>store.read(s),atomic)).revision,4);
  assert.equal((await oldRows(atomic)).filter(r=>r.phase==='failure-reviewed').length,1);assert.equal(fixture.calls.length,committedCalls);
  report.cases.push('failure record write abort rolls back proof/order/event atomically; lost committed local reply restores the existing single event after restart without repeating RPC');

  const lost=await observed('failure-http');loseFailureReply=true;assert.equal(await recoveryFailure(),'SUBMISSION_HTTP');loseFailureReply=false;
  assert.equal((await page.evaluate(s=>store.read(s),lost)).revision,3);const afterHttp=fixture.calls.length;
  await restart(lost);assert.equal((await recover()).status,'failed');assert.equal(fixture.calls.length,afterHttp);assert.equal(await count(),0);
  assert.equal((await page.evaluate(s=>store.readBuyerSubmission(s),lost)).sendClaim,null);assert.equal(await failure(),'SEND_NOT_READY');
  report.cases.push('lost HTTP failure reply restores retained SQLite proof for signed gateway-unsent bytes after both processes restart and blocks their first send');

  const stale=await observed('failure-stale');fixture.setMode('hold');let entered;
  const ready=new Promise(r=>entered=r);fixture.onRequest(()=>entered());const running=recoveryFailure();
  await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('failure recovery did not reach RPC')),10000);ready.finally(()=>clearTimeout(timer));})]);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:3}),stale);fixture.setMode('failure-finalized');fixture.onRequest(null);fixture.release();
  assert.notEqual(await running,'UNEXPECTED_SUCCESS');assert.equal((await page.evaluate(s=>store.read(s),stale)).items[0].attempts[0].state,'unknown');
  const staleCalls=fixture.calls.length;assert.equal((await recover()).status,'failed');assert.equal(fixture.calls.length,staleCalls);
  assert.equal((await page.evaluate(s=>store.read(s),stale)).paused,true);
  report.cases.push('changed paused order rejects an in-flight failure report; retained server evidence rebinds to current revision without unpausing or new RPC');

  const second=await expired('failure-second'),priorRows=await oldRows(second),first=await page.evaluate(s=>store.readBuyerAttempt(s,1),second);
  await native(second,await replace());await open(second);await spaced();await page.evaluate(()=>approveFixtureCost());await spaced();await page.evaluate(()=>client.signOnly(window.costConsent));
  await page.evaluate(s=>openSender(s),second);await spaced();assert.equal((await send()).status,'accepted');fixture.setMode('failure-finalized');await spaced();
  assert.equal((await recover()).status,'failed');await restart(second);const noRetry=fixture.calls.length;
  assert.equal((await recover()).outcome,'failed');assert.equal(await failure(),'SEND_NOT_READY');
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');
  assert.deepEqual((await page.evaluate(s=>store.read(s),second)).items[0].attempts.map(a=>a.state),['expired','failed']);assert.deepEqual(await oldRows(second),priorRows);
  assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,1),second)).wallet.response.transactionBase64,first.wallet.response.transactionBase64);
  const terminal=await page.evaluate(s=>store.readBuyerAttempt(s,2),second);assert.equal(terminal.submission.failureRecord.proof.slot,1450);assert.equal(terminal.submission.failureRecord.evidence.feeLamports,'10000');
  assert.equal(fixture.calls.length,noRetry);assert.equal(sends(),2);assert.equal(await count(),0);
  report.cases.push('second failure keeps first expiry and all old rows intact across restart; paid fee/evidence remain readable per attempt and no third attempt is allowed');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=sends();report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
