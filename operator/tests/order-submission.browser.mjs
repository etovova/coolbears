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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-submission-fixture-'));
const output=path.resolve('operator/build/buyer-submission-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,alter=false,loseReply=false,loseExpiryReply=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/review-expiry'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      let body=await response.text();if(alter&&response.status===200){const value=JSON.parse(body);value.report.orderSha256='0'.repeat(64);body=JSON.stringify(value);}
      if(loseReply&&req.url==='/api/buyer/send'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
      if(loseExpiryReply&&req.url==='/api/buyer/review-expiry'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
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
try{
  await runtime.start();await launch();const good=await signed('send-success');
  assert.equal(await page.evaluate(()=>code(sender.sendOnce())),'EXPLICIT_SEND_REQUIRED');
  const accepted=await send();assert.equal(accepted.status,'accepted');assert.equal(accepted.chainVerified,false);assert.equal(sends(),1);
  assert.equal((await page.evaluate(s=>store.read(s),good)).items[0].attempts[0].state,'unknown');
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>openSender(s),good);
  assert.equal(await failure(),'SEND_NOT_READY');await spaced();assert.equal((await recover()).status,'verified');assert.equal(sends(),1);
  const verified=await page.evaluate(s=>store.read(s),good);assert.equal(verified.revision,5);assert.equal(verified.items[0].attempts[0].state,'verified');
  const before=fixture.calls.length;assert.equal((await recover()).status,'already-recorded');assert.equal(fixture.calls.length,before);assert.equal(await count(),0);
  report.cases.push('signed check, durable browser/server claim and one exact send; complete browser/workerd restart recovers finalized proof without a second wallet/send');

  const abort=await signed('claim-rollback');await page.evaluate(()=>window.writeFailure='send-claimed');const countBefore=sends();
  assert.notEqual(await failure(),'UNEXPECTED_SUCCESS');assert.equal(sends(),countBefore);assert.equal((await page.evaluate(s=>store.read(s),abort)).revision,3);
  await page.evaluate(()=>window.writeFailure=null);
  report.cases.push('local claim write abort rolls back intent and order together; HTTP send never begins');

  const lostClaim=await signed('claim-ack');await page.evaluate(()=>window.loseSendClaimAck=true);
  assert.equal(await failure(),'LOST_CLAIM_ACK');await page.evaluate(()=>window.loseSendClaimAck=false);assert.equal(await failure(),'SEND_NOT_READY');assert.equal(sends(),countBefore);
  await spaced();assert.equal((await recover()).status,'unknown');
  report.cases.push('lost local claim acknowledgment keeps consumed intent and permits read-only unknown recovery only');

  const lost=await signed('lost-http-ack');loseReply=true;assert.equal(await failure(),'SUBMISSION_HTTP');loseReply=false;const once=sends();
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>openSender(s),lost);
  assert.equal(await failure(),'SEND_NOT_READY');await spaced();assert.equal((await recover()).status,'verified');assert.equal(sends(),once);assert.equal(await count(),0);
  report.cases.push('server-accepted send with lost HTTP reply is recovered after both processes restart; no resend or wallet call');

  const proof=await signed('proof-write');await send();await spaced();await page.evaluate(()=>window.failProofWrite=true);
  assert.notEqual(await page.evaluate(()=>code(sender.recover())),'UNEXPECTED_SUCCESS');assert.equal((await page.evaluate(s=>store.read(s),proof)).revision,4);
  await page.evaluate(()=>{window.failProofWrite=false;window.loseProofAck=true;});await spaced();
  assert.equal(await page.evaluate(()=>code(sender.recover())),'LOST_PROOF_ACK');await page.evaluate(()=>window.loseProofAck=false);
  const recoveredCalls=fixture.calls.length;assert.equal((await recover()).status,'already-recorded');assert.equal(fixture.calls.length,recoveredCalls);
  assert.equal((await page.evaluate(s=>store.read(s),proof)).revision,5);
  report.cases.push('proof persistence abort preserves unknown; lost successful proof acknowledgment recovers idempotently without network or duplicate history');

  const changed=await signed('stale-recovery');await send();await spaced();fixture.setMode('hold');let entered;const ready=new Promise(r=>entered=r);fixture.onRequest(()=>entered());
  const pending=page.evaluate(()=>code(sender.recover()));
  await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('recovery did not reach fixture')),10000);ready.finally(()=>clearTimeout(timer));})]);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:4}),changed);
  fixture.setMode('normal');fixture.onRequest(null);fixture.release();assert.notEqual(await pending,'UNEXPECTED_SUCCESS');
  assert.equal((await page.evaluate(s=>store.read(s),changed)).items[0].attempts[0].state,'unknown');
  await spaced();assert.equal((await recover()).status,'verified');assert.equal((await page.evaluate(s=>store.read(s),changed)).paused,true);
  report.cases.push('order changed during remote recovery rejects stale proof; a fresh read may verify while preserving the pause');

  const bad=await signed('tampered-proof');await send();await spaced();alter=true;assert.notEqual(await page.evaluate(()=>code(sender.recover())),'UNEXPECTED_SUCCESS');alter=false;
  assert.equal((await page.evaluate(s=>store.read(s),bad)).revision,4);await spaced();assert.equal((await recover()).status,'verified');
  report.cases.push('altered recovery response cannot write a receipt or release the consumed send claim');

  const parallel=await signed('two-tab-send');await spaced();fixture.setMode('hold');let sendEntered;const sendReady=new Promise(r=>sendEntered=r);fixture.onRequest(()=>sendEntered());
  const sending=send();await Promise.race([sendReady,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('send did not reach fixture')),10000);sendReady.finally(()=>clearTimeout(timer));})]);
  const second=await context.newPage();second.on('pageerror',e=>report.pageErrors.push(e.message));await second.goto(origin);await second.waitForFunction(()=>window.openSender);await second.evaluate(s=>openSender(s),parallel);
  assert.equal(await second.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true}))),'SEND_NOT_READY');
  fixture.setMode('normal');fixture.onRequest(null);fixture.release();assert.equal((await sending).status,'accepted');await second.close();
  report.cases.push('another tab cannot reuse the committed send intent while the first HTTP request is pending');

  const sendsBeforeExpiry=sends();
  const expiry=await signed('expiry-saved'),originalBytes=await page.evaluate(s=>(store.readBuyerResponse(s)).then(v=>v.response.transactionBase64),expiry);
  const beforeReview=fixture.calls.length;
  assert.equal(await page.evaluate(()=>code(sender.reviewExpiry())),'EXPLICIT_EXPIRY_REVIEW_REQUIRED');assert.equal(fixture.calls.length,beforeReview);
  fixture.setMode('expiry-clear');assert.equal((await review()).status,'expired');
  assert.equal((await page.evaluate(s=>store.read(s),expiry)).revision,4);
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>openSender(s),expiry);
  const retiredCalls=fixture.calls.length;assert.equal((await review()).status,'already-recorded');assert.equal((await recover()).outcome,'expired');
  assert.equal(await failure(),'SEND_NOT_READY');assert.equal(fixture.calls.length,retiredCalls);assert.equal(await count(),0);
  assert.equal(await page.evaluate(s=>store.readBuyerResponse(s).then(v=>v.response.transactionBase64),expiry),originalBytes);
  report.cases.push('explicit expiry review atomically retires signed unsent bytes; full browser/server restart preserves evidence and never invokes wallet or send');

  fixture.setMode('normal');const incomplete=await signed('expiry-incomplete');fixture.setMode('expiry-empty');
  assert.equal((await review()).status,'unknown');assert.equal((await page.evaluate(s=>store.read(s),incomplete)).revision,3);
  await spaced();fixture.setMode('expiry-clear');assert.equal((await review()).status,'expired');
  report.cases.push('empty payer history keeps the browser attempt unknown until an explicit complete review succeeds');

  fixture.setMode('normal');const httpExpiry=await signed('expiry-http-ack');fixture.setMode('expiry-clear');loseExpiryReply=true;
  assert.equal(await reviewFailure(),'SUBMISSION_HTTP');loseExpiryReply=false;
  assert.equal((await page.evaluate(s=>store.read(s),httpExpiry)).revision,3);const expiryRpc=fixture.calls.length;
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>openSender(s),httpExpiry);
  assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,expiryRpc);assert.equal(await count(),0);
  report.cases.push('lost expiry HTTP reply restores the durable server proof after both processes restart without repeating RPC');

  fixture.setMode('normal');const atomicExpiry=await signed('expiry-write');fixture.setMode('expiry-clear');
  await page.evaluate(()=>window.writeFailure='expiry-reviewed');assert.notEqual(await reviewFailure(),'UNEXPECTED_SUCCESS');
  assert.equal((await page.evaluate(s=>store.read(s),atomicExpiry)).revision,3);
  await page.evaluate(()=>{window.writeFailure=null;window.loseExpiryAck=true;});const savedExpiryCalls=fixture.calls.length;
  assert.equal(await reviewFailure(),'LOST_EXPIRY_ACK');assert.equal(fixture.calls.length,savedExpiryCalls);
  await context.close();context=null;await launch();await page.evaluate(s=>openSender(s),atomicExpiry);
  assert.equal((await review()).status,'already-recorded');assert.equal((await page.evaluate(s=>store.read(s),atomicExpiry)).revision,4);
  assert.equal(fixture.calls.length,savedExpiryCalls);
  report.cases.push('expiry evidence write abort rolls back order and event together; lost committed browser reply is idempotent after restart');

  fixture.setMode('normal');const staleExpiry=await signed('expiry-stale');fixture.setMode('hold');let expiryEntered;
  const expiryReady=new Promise(r=>expiryEntered=r);fixture.onRequest(()=>expiryEntered());const reviewing=reviewFailure();
  await Promise.race([expiryReady,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('expiry did not reach fixture')),10000);expiryReady.finally(()=>clearTimeout(timer));})]);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:3}),staleExpiry);
  fixture.setMode('expiry-clear');fixture.onRequest(null);fixture.release();assert.notEqual(await reviewing,'UNEXPECTED_SUCCESS');
  assert.equal((await page.evaluate(s=>store.read(s),staleExpiry)).items[0].attempts[0].state,'unknown');
  const staleCalls=fixture.calls.length;assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,staleCalls);
  assert.equal((await page.evaluate(s=>store.read(s),staleExpiry)).paused,true);
  report.cases.push('changed order rejects an in-flight expiry result; explicit restore rebinds to current revision and retains pause');

  fixture.setMode('normal');const alteredExpiry=await signed('expiry-altered');fixture.setMode('expiry-clear');alter=true;
  assert.notEqual(await reviewFailure(),'UNEXPECTED_SUCCESS');alter=false;assert.equal((await page.evaluate(s=>store.read(s),alteredExpiry)).revision,3);
  const alteredCalls=fixture.calls.length;assert.equal((await review()).status,'expired');assert.equal(fixture.calls.length,alteredCalls);
  report.cases.push('altered HTTPS expiry binding cannot change the browser journal; original persisted proof remains recoverable');

  fixture.setMode('normal');const consumedExpiry=await signed('expiry-consumed-send');fixture.setMode('fee-rise');assert.equal(await failure(),'SUBMISSION_HTTP');
  await spaced();fixture.setMode('expiry-clear');assert.equal((await review()).status,'expired');
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await page.evaluate(s=>openSender(s),consumedExpiry);
  const terminal=await page.evaluate(s=>store.readBuyerSubmission(s),consumedExpiry);assert.equal(terminal.status,'expired');assert.ok(terminal.sendClaim);
  assert.equal(await failure(),'SEND_NOT_READY');assert.equal((await review()).status,'already-recorded');assert.equal(sends(),sendsBeforeExpiry);
  report.cases.push('cost-rejected send keeps both permanent claims after expiry and full browser/server restart');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();
  report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=sends();report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
