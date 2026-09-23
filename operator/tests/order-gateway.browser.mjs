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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-https-fixture-'));
const output=path.resolve('operator/build/buyer-gateway-chromium');await mkdir(output,{recursive:true});
const fixture=await buyerGatewayFixture({syntheticOwner:true}),bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-gateway-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,
  inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture)]});
const bytes=await readFile(bundle);
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,alter=false,context,page;
const report={passed:false,engine:'chromium',transport:'HTTPS to local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',
  realWallets:false,physicalPhones:false,liveRpc:false,persistencePermission:'fixture only',transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(['/api/buyer/check','/api/buyer/prepare'].includes(req.url)){
      const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)});
      let body=await response.text();if(alter&&response.status===200){const value=JSON.parse(body);value.report.candidate.messageSha256='0'.repeat(64);body=JSON.stringify(value);}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
    }else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}
    else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable buyer gateway integration</title><script type="module" src="/fixture.js"></script>');}
  }catch(e){report.pageErrors.push('bridge:'+e.message);res.writeHead(503);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${server.address().port}`;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite')});
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
  await open(scope,buyer.secretKey);return scope;
}
const failure=()=>page.evaluate(()=>code(client.signOnly()));
const count=()=>page.evaluate(()=>walletCalls);
const spaced=()=>new Promise(r=>setTimeout(r,250));
try{
  await runtime.start();await launch();const good=await setup('https-success');
  const result=await page.evaluate(()=>client.signOnly());assert.equal(result.status,'buyer-response-saved');assert.equal(result.readyToSubmit,false);
  assert.equal(await count(),1);assert.equal(fixture.calls.length,13);
  const order=await page.evaluate(s=>store.read(s),good);assert.equal(order.revision,3);assert.equal(order.items[0].attempts[0].state,'unknown');
  report.cases.push('real HTTPS checker verifies account state and exact bytes before one sign-only wallet call; response commits to IndexedDB');
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();await open(good);
  assert.deepEqual(await page.evaluate(()=>client.recover()),result);assert.equal(await failure(),'NOT_READY');assert.equal(await count(),0);assert.equal(fixture.calls.length,13);
  report.cases.push('full browser and workerd restart preserve signed evidence without another RPC or wallet invocation');
  const unfinished={...base,id:'prepare-before-browser-crash'};
  const prepared=await page.evaluate(async scope=>{const order=await store.create({...scope,quantity:1,available:9999});return prepareThroughGateway({order});},unfinished);
  const afterPreparation=fixture.calls.length;
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();
  const restored=await page.evaluate(async scope=>{const order=await store.read(scope);return prepareThroughGateway({order});},unfinished);
  assert.equal(restored.restored,true);assert.deepEqual(restored.candidate,prepared.candidate);assert.equal(fixture.calls.length,afterPreparation);
  const fresh=await page.evaluate(s=>store.read(s),unfinished);assert.equal(fresh.revision,0);assert.equal(fresh.items[0].attempts.length,0);
  report.cases.push('browser plus SQLite restart between preparation and asset signing restores the original hash without RPC or new signatures');
  await setup('altered-http-response');alter=true;await spaced();assert.notEqual(await failure(),'UNEXPECTED_SUCCESS');alter=false;assert.equal(await count(),0);
  report.cases.push('altered HTTPS response cannot authorize a wallet call');
  const ordinary=await setup('closed-ordinary',fixture.key('ordinary'));const before=fixture.calls.length;assert.equal(await failure(),'CHECK_HTTP');assert.equal(await count(),0);assert.equal(fixture.calls.length,before);
  report.cases.push('ordinary buyer remains blocked by closed profile before upstream');
  const changed=await setup('changed-local-order');await spaced();fixture.setMode('hold');let entered;const ready=new Promise(r=>entered=r);fixture.onRequest(()=>entered());
  const pending=failure();await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture upstream was not reached')),10000);ready.finally(()=>clearTimeout(timer));})]);
  await page.evaluate(s=>store.append(s,{type:'pause',revision:1}),changed);
  fixture.setMode('normal');fixture.onRequest(null);fixture.release();assert.notEqual(await pending,'UNEXPECTED_SUCCESS');assert.equal(await count(),0);
  const paused=await page.evaluate(s=>store.read(s),changed);assert.equal(paused.paused,true);assert.equal(paused.revision,2);
  report.cases.push('local order changed during remote check blocks durable wallet claim and signing');
  await setup('failed-simulation');await spaced();fixture.setMode('simulation');assert.equal(await failure(),'CHECK_HTTP');assert.equal(await count(),0);fixture.setMode('normal');
  report.cases.push('failed real checker simulation blocks browser wallet handoff');
  await setup('upstream-cooldown');await spaced();fixture.setMode('429');assert.equal(await failure(),'CHECK_HTTP');const charged=fixture.calls.length;
  await runtime.stop();await runtime.start();assert.equal(await failure(),'CHECK_HTTP');assert.equal(fixture.calls.length,charged);assert.equal(await count(),0);
  report.cases.push('upstream 429 and runtime restart preserve cooldown; browser cannot bypass it');
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  fixture.setMode('normal');fixture.release();
  report.upstreamCalls=fixture.calls.length;report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
