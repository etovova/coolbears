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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-prewallet-recovery-fixture-'));
const output=path.resolve('operator/build/buyer-prewallet-recovery-chromium');await mkdir(output,{recursive:true});
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
      if(loseFailureReply&&req.url==='/api/buyer/recover-prewallet'&&response.status===200){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
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
try{
  await runtime.start();await launch();
  const untouched={...base,id:'prewallet-unsigned'};await page.evaluate(s=>store.create({...s,quantity:1,available:9999}),untouched);
  const initial=await read(untouched);assert.equal(await page.evaluate(s=>store.readPrewalletRecovery(s),untouched),null);assert.deepEqual(await read(untouched),initial);assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('unprepared order remains unchanged with no invented claim or signature');

  const missing=await setup('prewallet-restart'),original=await rows(missing.scope);assert.equal(original.length,1);await restart(missing.scope);
  assert.equal((await discover()).status,'verified');assert.deepEqual(await stats(),{native:0,wallet:0});
  const stored=await rows(missing.scope);assert.deepEqual(stored.slice(0,1),original);assert.deepEqual(stored.map(r=>r.phase),['claimed','prewallet-recovered']);
  assert.equal((await read(missing.scope)).revision,2);assert.equal((await read(missing.scope)).items[0].attempts[0].state,'verified');
  assert.equal(await page.evaluate(s=>store.readBuyerResponse(s),missing.scope),null);assert.equal(await page.evaluate(s=>store.readBuyerSubmission(s),missing.scope),null);
  const calls=fixture.calls.length;await restart(missing.scope);assert.equal((await discover()).status,'already-recorded');assert.equal(fixture.calls.length,calls);
  assert.equal(await page.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true}))),'SEND_NOT_READY');
  report.cases.push('full browser restart loses volatile native bytes; exact final proof adds only reconcile and terminal row, no ready row, wallet claim or send permission');

  const partial=await setup('prewallet-partial',{native:true}),partialRows=await rows(partial.scope),count=await stats();
  assert.equal((await discover()).status,'verified');assert.deepEqual((await rows(partial.scope)).slice(0,2),partialRows);assert.deepEqual(await stats(),count);
  const attempt=await page.evaluate(s=>store.readBuyerAttempt(s,1),partial.scope);assert.equal(attempt.prewallet.status,'verified');assert.equal(attempt.wallet,null);assert.equal(attempt.signing.status,'asset-signing-reconciled');
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),partial.scope)).status,'asset-signing-reconciled');
  report.cases.push('saved partial is preserved and terminal history exposes the observed proof without fabricating wallet invocation or another native signature');

  const absent=await setup('prewallet-empty',{observed:false}),absentRows=await rows(absent.scope);await restart(absent.scope);
  assert.equal((await discover()).status,'unknown');assert.deepEqual(await rows(absent.scope),absentRows);
  fixture.receipt(absent.bytes);fixture.setMode('pending');await spaced();assert.equal((await discover()).status,'unknown');
  fixture.setMode('normal');await spaced();assert.equal((await discover()).status,'verified');assert.deepEqual(await stats(),{native:0,wallet:0});
  report.cases.push('empty and nonfinalized history leaves consumed native claim unknown; only later exact final evidence closes it');

  const failed=await setup('prewallet-failed',{native:true});fixture.setMode('failure-finalized');loseFailureReply=true;
  assert.equal(await discoverError(),'SUBMISSION_HTTP');loseFailureReply=false;const failedCalls=fixture.calls.length;await restart(failed.scope);
  const result=await discover();assert.equal(result.status,'failed');assert.equal(result.feeLamports,'10000');assert.equal(fixture.calls.length,failedCalls);
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}))),'REPLACEMENT_NOT_READY');
  report.cases.push('lost server reply restores paid failure after both restarts; missing wallet provenance never authorizes replacement');

  for(const fault of ['terminal','event']){
    const item=await setup('prewallet-abort-'+fault),beforeRows=await rows(item.scope);
    await page.evaluate(fault=>{window.writeFailure=fault==='terminal'?'prewallet-recovered':null;window.failProofWrite=fault==='event';},fault);
    assert.notEqual(await discoverError(),'UNEXPECTED_SUCCESS');assert.deepEqual(await rows(item.scope),beforeRows);assert.equal((await read(item.scope)).revision,1);
    const rpc=fixture.calls.length;await restart(item.scope);assert.equal((await discover()).status,'verified');assert.equal(fixture.calls.length,rpc);
  }
  report.cases.push('IndexedDB abort at either reconcile event or terminal row rolls back all changes and cached server evidence repairs it after restart');

  const ack=await setup('prewallet-local-ack');await page.evaluate(()=>window.losePrewalletAck=true);assert.equal(await discoverError(),'LOST_PREWALLET_ACK');
  const ackCalls=fixture.calls.length;await restart(ack.scope);assert.equal((await discover()).status,'already-recorded');assert.equal(fixture.calls.length,ackCalls);
  report.cases.push('lost local acknowledgment restores saved terminal evidence without another HTTP request or signature');

  const readback=await setup('prewallet-readback');await page.evaluate(()=>window.losePrewalletReadback=true);assert.equal(await discoverError(),'ASSET_KEY_MISMATCH');
  const readbackCalls=fixture.calls.length,readbackStats=await stats();
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),readback.scope)).status,'asset-signing-reconciled');
  assert.equal((await discover()).status,'already-recorded');assert.equal(fixture.calls.length,readbackCalls);assert.deepEqual(await stats(),readbackStats);
  report.cases.push('lost terminal custody readback retains committed proof; native recovery releases volatile result only after validated terminal read and never writes a partial');

  const paused=await setup('prewallet-pause'),prior=await page.evaluate(s=>store.readPrewalletRecovery(s),paused.scope);
  const beforePause=await page.evaluate(v=>responseTransport.recoverPrewallet(v),prior.input);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:1}),paused.scope);
  assert.notEqual(await page.evaluate(({s,r})=>code(store.savePrewalletRecovery(s,r)),{s:paused.scope,r:beforePause}),'UNEXPECTED_SUCCESS');
  const pausedCalls=fixture.calls.length;assert.equal((await discover()).status,'verified');assert.equal((await read(paused.scope)).paused,true);assert.equal(fixture.calls.length,pausedCalls);
  report.cases.push('pause rejects stale report; cached proof rebinds to current revision and preserves pause');

  const lateNative=await setup('prewallet-late-native'),state=await page.evaluate(s=>store.readPrewalletRecovery(s),lateNative.scope);
  const terminal=await page.evaluate(v=>responseTransport.recoverPrewallet(v),state.input);
  assert.equal((await page.evaluate(s=>store.recoverAssetSigning(s),lateNative.scope)).status,'asset-partial-saved');
  assert.notEqual(await page.evaluate(({s,r})=>code(store.savePrewalletRecovery(s,r)),{s:lateNative.scope,r:terminal}),'UNEXPECTED_SUCCESS');
  const nativeCalls=fixture.calls.length,nativeStats=await stats();assert.equal((await discover()).status,'verified');assert.equal(fixture.calls.length,nativeCalls);assert.deepEqual(await stats(),nativeStats);
  report.cases.push('late retention of original native bytes rejects stale null-partial report; cached proof binds to the actual partial without signing again');

  const late=await setup('prewallet-late-wallet',{native:true,observed:false}),beforeWallet=await page.evaluate(s=>store.readPrewalletRecovery(s),late.scope);
  await walletSign(late.scope);fixture.receipt(late.bytes);
  const stale=await page.evaluate(v=>responseTransport.recoverPrewallet(v),beforeWallet.input);
  assert.notEqual(await page.evaluate(({s,r})=>code(store.savePrewalletRecovery(s,r)),{s:late.scope,r:stale}),'UNEXPECTED_SUCCESS');
  const walletRows=await rows(late.scope),walletCalls=fixture.calls.length;assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');assert.equal(fixture.calls.length,walletCalls);
  assert.deepEqual((await rows(late.scope)).slice(0,4),walletRows);assert.equal((await rows(late.scope)).some(r=>r.phase==='prewallet-recovered'),false);
  report.cases.push('genuine later wallet claim and response remain intact; stale prewallet save fails and ordinary recovery reuses the retained proof');

  const second=await setup('prewallet-second',{native:true,observed:false});await walletSign(second.scope);fixture.receipt(second.bytes);fixture.setMode('failure-finalized');await spaced();
  assert.equal((await page.evaluate(()=>sender.recover())).status,'failed');const firstRows=await rows(second.scope);
  fixture.setGeneration(2);fixture.setMode('normal');await spaced();const replacement=await page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'}));
  await page.evaluate(()=>window.writeFailure='ready');assert.notEqual(await page.evaluate(({s,r})=>code(store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true,acknowledgedFeeLamports:'10000'})),{s:second.scope,r:replacement}),'UNEXPECTED_SUCCESS');
  await page.evaluate(()=>window.writeFailure=null);fixture.receipt(await observe(second.scope));await restart(second.scope);assert.equal((await discover()).status,'verified');
  const history=await page.evaluate(async s=>[await store.readBuyerAttempt(s,1),await store.readBuyerAttempt(s,2)],second.scope);
  assert.equal(history[0].submission.failureRecord.evidence.feeLamports,'10000');assert.equal(history[1].prewallet.status,'verified');assert.deepEqual((await rows(second.scope)).slice(0,firstRows.length),firstRows);
  report.cases.push('second native claim recovers after a genuine acknowledged paid-failure replacement while retaining every first-attempt row and fee proof');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);assert.equal(fixture.calls.filter(c=>c.method==='sendTransaction').length,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(c=>c.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
