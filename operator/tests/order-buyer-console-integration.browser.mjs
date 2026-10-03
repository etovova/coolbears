// Configured production app/factory -> real Chromium IDB -> HTTPS -> workerd/SQLite.
// Wallet keys, storage permission and all upstream RPC responses are disposable fixtures.
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
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-private-console-integration-'));
const output=path.resolve('operator/build/buyer-console-integration-chromium');await mkdir(output,{recursive:true});
const source='operator/orders/buyer-console',fixture=await buyerGatewayFixture({syntheticOwner:true});
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,bytes,context,page;
const report={passed:false,engine:'chromium',adapters:'configured production app/factory, actual browser IndexedDB/WebLocks and HTTPS gateway adapters',
  transport:'local workerd with real SQLite',tlsCertificate:'disposable self-signed test only',persistencePermission:'fixture only',
  realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,externalRequests:0,pageErrors:[],httpFailures:[],cases:[]};
const httpRoutes=[];
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(req.url.startsWith('/api/buyer/')){
      httpRoutes.push(req.url);const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)}),body=await response.text();
      if(response.status!==200){let code;try{const value=JSON.parse(body).code;if(typeof value==='string'&&/^[A-Z_]+$/.test(value))code=value;}catch{}
        report.httpFailures.push({route:req.url,status:response.status,...(code?{code}:{})});}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);return;
    }
    const file=req.url==='/'?path.join(source,'index.html'):req.url==='/style.css'?path.join(source,'style.css'):null;
    if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(bytes);}
    else if(file){res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css':'text/html','cache-control':'no-store'});res.end(await readFile(file));}
    else{res.writeHead(404);res.end();}
  }catch(error){report.pageErrors.push('bridge:'+error.message);res.writeHead(503);res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;
const bundle=await build({entryPoints:['operator/tests/fixtures/buyer-console-integration.mjs'],bundle:true,write:false,
  platform:'browser',format:'esm',target:'es2022',inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture),{
    name:'private-console-integration-inputs',setup(b){
      b.onResolve({filter:/^private-console:/},args=>({path:args.path,namespace:'console-fixture'}));
      b.onLoad({filter:/.*/,namespace:'console-fixture'},args=>({contents:'export default '+JSON.stringify(args.path==='private-console:config'?fixture.config(origin):[...fixture.owner.secretKey]),loader:'js'}));
    },
  }]});bytes=bundle.outputFiles[0].contents;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:false});
const spaced=()=>new Promise(resolve=>setTimeout(resolve,250));
const button=id=>page.locator('#'+id);
async function ready(){
  await page.waitForFunction(()=>window.integration?.loaded&&document.getElementById('workspace').getAttribute('aria-busy')==='false');
  assert.equal(await button('error').isVisible(),false,await button('error').textContent());
}
async function click(id,{network=false}={}){if(network)await spaced();await button(id).click();await ready();}
const counters=()=>page.evaluate(()=>structuredClone(integration.counters));
const journal=()=>page.evaluate(()=>integration.journal());
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));await page.goto(origin);await ready();
}
try{
  await runtime.start();await launch();
  assert.deepEqual(await counters(),{native:0,wallet:0,send:0,connect:0,persist:0});assert.equal(httpRoutes.length,0);assert.equal(fixture.calls.length,0);
  assert.equal(await button('send').isDisabled(),true);assert.equal(await button('send-consent').isDisabled(),true);
  await button('storage-consent').check();await click('persist');assert.equal((await counters()).persist,1);
  await button('wallets').selectOption('0');await click('connect');await button('accounts').selectOption(fixture.policy.owner);await click('choose-account');
  await button('quantity').fill('1');await click('create');assert.match(await button('progress').textContent(),/0 of 1/);
  const initial=await journal();assert.equal(initial.orders.length,1);assert.equal(initial.keys.length,1);assert.equal(initial.keys[0].privateType,'private');assert.equal(initial.keys[0].extractable,false);
  const id=initial.orders[0].id;
  await click('prepare',{network:true});assert.equal((await counters()).native,1);assert.equal((await counters()).wallet,0);
  await click('quote',{network:true});assert.match(await button('costs').textContent(),/0\.203509999 SOL/);assert.equal(await button('sign').isDisabled(),true);
  assert.equal(await button('cost-cap').inputValue(),'0.203509999');await button('cost-consent').check();await click('sign',{network:true});
  assert.equal((await counters()).wallet,1);assert.equal((await counters()).native,1);assert.equal((await counters()).send,0);
  assert.equal(await button('sign').isDisabled(),true);assert.equal(await button('send').isDisabled(),true);assert.match(await button('items').textContent(),/Outcome unknown/);
  const signed=await journal(),signedBytes=await page.evaluate(()=>integration.signedBytes),before=await counters();
  assert.ok(signedBytes);assert.deepEqual(signed.signing.map(row=>row.phase),['claimed','ready','wallet-claimed','buyer-response']);
  assert.equal(signed.signing.at(-1).record.transactionBase64,signedBytes);assert.equal(signed.orders[0].items[0].attempts[0].state,'unknown');
  assert.equal(signed.signing[2].record.costApproval.maxTotalLamports,'203509999');
  const requestsBefore=httpRoutes.length,rpcBefore=fixture.calls.length;
  await context.close();context=null;await runtime.stop();await runtime.start();await launch();
  assert.deepEqual(await counters(),before);assert.equal(httpRoutes.length,requestsBefore);assert.equal(fixture.calls.length,rpcBefore);
  await button('orders').selectOption(id);await click('resume-order');assert.deepEqual(await journal(),signed);
  assert.equal(await button('sign').isDisabled(),true);assert.equal(await button('send').isDisabled(),true);assert.equal(await button('cost-consent').isChecked(),false);
  assert.match(await button('items').textContent(),/Outcome unknown/);assert.equal(httpRoutes.length,requestsBefore);
  await click('recover',{network:true});assert.match(await button('outcome').textContent(),/unknown/);assert.deepEqual(await journal(),signed);assert.deepEqual(await counters(),before);
  fixture.receipt(signedBytes);await click('recover',{network:true});assert.match(await button('progress').textContent(),/1 of 1 items verified.*Complete/);
  assert.match(await button('items').textContent(),/Verified/);assert.match(await button('outcome').textContent(),/verified/);assert.deepEqual(await counters(),before);
  const verified=await journal();assert.equal(verified.orders[0].items[0].attempts[0].state,'verified');assert.deepEqual(verified.signing,signed.signing);
  assert.equal(verified.events.length,signed.events.length+1);assert.equal(verified.events.at(-1).type,'reconcile');
  assert.equal(await button('send').isDisabled(),true);assert.equal(httpRoutes.includes('/api/buyer/send'),false);
  assert.deepEqual(httpRoutes,['/api/buyer/prepare','/api/buyer/check','/api/buyer/check','/api/buyer/recover','/api/buyer/recover']);
  assert.equal(fixture.calls.filter(call=>call.method==='sendTransaction').length,0);
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.httpFailures,[]);assert.equal(report.externalRequests,0);
  report.cases.push('configured production app/factory and real UI create native non-extractable IndexedDB custody, prepare via HTTPS, issue exact cost consent and sign only once; a full browser/SQLite restart retains the same order without action, explicit recovery preserves unknown before recording observed final proof, and both production UI and gateway send gates remain closed');
  report.nativeTransactionSignatures=before.native;report.syntheticWalletSignatures=before.wallet;report.passed=true;
}finally{
  report.httpRoutes=httpRoutes;report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(call=>call.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true});
}
