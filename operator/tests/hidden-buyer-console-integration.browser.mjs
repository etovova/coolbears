// Hidden Settings production factory -> actual Chromium IDB -> HTTPS -> local
// workerd/SQLite. All identities, permission responses and RPC data are fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {VersionedTransaction} from '@solana/web3.js';
import {build} from 'esbuild';
import {hiddenBuyerGatewayFixture} from './fixtures/hidden-buyer-gateway.mjs';
import {buyerGatewayRuntime,fixturePolicyPlugin} from './fixtures/buyer-gateway-runtime.mjs';
import {baseAssetBytes,CORE_CREATE_LAMPORTS} from '../orders/mint-cost.mjs';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-hidden-console-chromium-'));
const cluster=process.env.COOLBEARS_BUYER_FIXTURE_CLUSTER??'devnet';assert.ok(['devnet','mainnet-beta'].includes(cluster));
const authorizeMainnet=cluster==='mainnet-beta';
const output=path.resolve('operator/build/hidden-buyer-console-integration-'+(authorizeMainnet?'mainnet-':'')+'chromium');await mkdir(output,{recursive:true});
const hash=createHash('sha256').update('SYNTHETIC HIDDEN CHROMIUM PRIVATE MAPPING FIXTURE ONLY').digest('hex');
const fixture=hiddenBuyerGatewayFixture({syntheticOwner:true,redeemed:999,hiddenCommitmentSha256:hash,cluster});
await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(parent,'key.pem'),'-out',path.join(parent,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1']);
let runtime,origin,bytes,context,page;
const report={passed:false,engine:'chromium',cluster,storageMode:'hidden-settings',
  adapters:'production console/factory, actual IndexedDB/Web Locks and HTTPS gateway',transport:'local workerd/SQLite with synthetic upstream RPC',
  realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,externalRequests:0,pageErrors:[],httpFailures:[],cases:[]};
const httpRoutes=[];
const source='operator/orders/buyer-console';
const server=createServer({key:await readFile(path.join(parent,'key.pem')),cert:await readFile(path.join(parent,'cert.pem'))},async(req,res)=>{
  try{
    if(req.url.startsWith('/api/buyer/')){
      httpRoutes.push(req.url);const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await runtime.dispatch(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(parts)}),body=await response.text();
      if(response.status!==200){let code;try{code=JSON.parse(body).code;}catch{}report.httpFailures.push({route:req.url,status:response.status,code});}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);return;
    }
    const file=req.url==='/'?path.join(source,'index.html'):req.url==='/style.css'?path.join(source,'style.css'):null;
    if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(bytes);}
    else if(file){res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css':'text/html','cache-control':'no-store'});res.end(await readFile(file));}
    else{res.writeHead(404);res.end();}
  }catch(error){report.pageErrors.push('bridge:'+error.message);res.writeHead(503);res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;
const bundled=await build({entryPoints:['operator/tests/fixtures/hidden-buyer-console-integration.mjs'],bundle:true,write:false,
  platform:'browser',format:'esm',target:'es2022',inject:['scripts/browser-buffer.mjs'],plugins:[fixturePolicyPlugin(fixture),{
    name:'hidden-console-fixture-inputs',setup(b){b.onResolve({filter:/^private-console:/},args=>({path:args.path,namespace:'hidden-console-fixture'}));
      b.onLoad({filter:/.*/,namespace:'hidden-console-fixture'},args=>({contents:'export const authorizeMainnet='+JSON.stringify(authorizeMainnet)+';export default '+JSON.stringify(args.path==='private-console:config'?fixture.config(origin):[...fixture.owner.secretKey]),loader:'js'}));},
  }]});bytes=bundled.outputFiles[0].contents;
runtime=await buyerGatewayRuntime({fixture,origin,persist:path.join(parent,'sqlite'),allowSubmission:false,authorizeMainnet,
  ...(authorizeMainnet?{trustedHiddenCommitmentSha256:hash}:{})});
const button=id=>page.locator('#'+id),counters=()=>page.evaluate(()=>structuredClone(integration.counters)),journal=()=>page.evaluate(()=>integration.journal());
async function ready(){await page.waitForFunction(()=>window.integration?.rawKeys&&(document.getElementById('workspace').hidden
    ||document.getElementById('workspace').getAttribute('aria-busy')==='false'));
  assert.equal(await button('workspace').isVisible(),true,await button('configuration').textContent());
  assert.equal(await button('error').isVisible(),false,await button('error').textContent());}
async function click(id,{network=false}={}){if(network)await new Promise(resolve=>setTimeout(resolve,250));await button(id).click();await ready();}
async function launch(){context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,ignoreHTTPSErrors:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));await page.goto(origin);await ready();}
try{
  await runtime.start();await launch();
  assert.match(await button('configuration').textContent(),authorizeMainnet?/Mainnet/:/Devnet/);
  assert.match(await button('network-banner').textContent(),authorizeMainnet?/Mainnet/:/Devnet/);
  assert.match(await button('wallet-network').textContent(),authorizeMainnet?/Mainnet/:/Devnet/);
  assert.equal(await button('wallets').locator('option').count(),2);
  assert.deepEqual(await counters(),{native:0,wallet:0,send:0,connect:0,persist:0});assert.equal(httpRoutes.length,0);
  assert.equal(await button('send').isDisabled(),true);
  await button('storage-consent').check();await click('persist');await button('wallets').selectOption('0');await click('connect');
  await button('accounts').selectOption(fixture.policy.owner);await click('choose-account');await button('quantity').fill('1');await click('create');
  const fresh=await journal();assert.equal(fresh.orders.length,1);assert.equal(fresh.orders[0].version,2);
  assert.equal(fresh.orders[0].storageMode,'hidden-settings');assert.equal(fresh.orders[0].hiddenCommitmentSha256,hash);
  assert.equal(fresh.keys[0].extractable,false);const id=fresh.orders[0].id;
  // Read the scope from the durable journal, not a reconstructed production input.
  const hiddenScope=await page.evaluate(async()=>integration.scope((await integration.journal()).orders[0]));
  await page.reload();await ready();assert.deepEqual(await journal(),fresh);assert.equal((await counters()).native,0);
  await button('orders').selectOption(id);await click('resume-order');
  report.cases.push('version2 hidden scope, digest and native non-extractable custody survive page reload; loading performs no signing or RPC');
  // Reload deliberately forgets the live wallet selection. Restore it only by
  // explicit UI actions before asking the production controller for a quote.
  await button('wallets').selectOption('0');await click('connect');
  await button('accounts').selectOption(fixture.policy.owner);await click('choose-account');

  const coexist=await page.evaluate(async s=>{const old=integration.legacyScope(s),legacy=await integration.legacy.create({...old,quantity:1,available:9999});
    const current=await integration.storage.read(s);return{legacy,current,keys:await integration.rawKeys(),wrong:await integration.wrongProfile(s)};},hiddenScope);
  assert.equal(coexist.legacy.version,1);assert.deepEqual(coexist.current,fresh.orders[0]);assert.equal(coexist.keys.length,2);
  assert.equal(coexist.wrong,'ORDER_STORAGE_PROFILE_MISMATCH');
  assert.ok(coexist.keys.some(key=>key.includes('"storageMode":"hidden-settings"')&&key.includes(hash)));
  assert.ok(coexist.keys.some(key=>!key.includes('"storageMode"')));
  assert.notEqual(coexist.legacy.items[0].asset,coexist.current.items[0].asset);
  report.cases.push('same identity v1 legacy and v2 hidden records coexist with separate native keys; wrong trusted commitment cannot restore or overwrite hidden custody');

  await click('prepare',{network:true});assert.equal((await counters()).native,1);assert.equal((await counters()).wallet,0);
  const prepared=await journal(),request=prepared.signing.find(row=>row.phase==='ready').record;
  assert.equal(request.orderIdentitySha256,prepared.signing[0].record.orderIdentitySha256);
  const unsigned=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));
  const canonical=fixture.planner.buildOrderItemTemplate(coexist.current,0,fixture.block);
  assert.deepEqual(Buffer.from(unsigned.message.serialize()),Buffer.from(VersionedTransaction.deserialize(canonical.unsignedBytes).message.serialize()));
  assert.equal(unsigned.message.staticAccountKeys[0].toBase58(),fixture.policy.owner);
  assert.equal(unsigned.message.staticAccountKeys[1].toBase58(),coexist.current.items[0].asset);
  assert.ok(unsigned.signatures[0].every(byte=>byte===0));assert.ok(unsigned.signatures[1].some(byte=>byte!==0));
  assert.ok(unsigned.serialize().length<=1232);
  report.cases.push('production preparation issues canonical hidden v2 purchase, persists native asset signature once and leaves buyer signature empty');

  await click('quote',{network:true});
  const base=baseAssetBytes(fixture.policy,{buyer:fixture.policy.owner,collection:fixture.roles.collection,...fixture.storageOptions},1000,fixture.storageOptions);
  const total=200000000n+10000n+BigInt(5080*(base.length+128))+CORE_CREATE_LAMPORTS;
  const sol=`${total/1000000000n}.${String(total%1000000000n).padStart(9,'0').replace(/0+$/,'')}`;
  assert.equal(await button('cost-cap').inputValue(),sol);assert.equal(await button('sign').isDisabled(),true);
  assert.match(await button('costs').textContent(),new RegExp(sol.replace('.','\\.')));
  await button('cost-consent').check();await click('sign',{network:true});
  assert.deepEqual(await counters(),{native:1,wallet:1,send:0,connect:4,persist:1});
  const signed=await journal(),signedBytes=await page.evaluate(()=>integration.signedBytes),before=await counters();
  assert.deepEqual(signed.signing.map(row=>row.phase),['claimed','ready','wallet-claimed','buyer-response']);
  assert.equal(signed.signing[2].record.costApproval.maxTotalLamports,total.toString());
  assert.equal(signed.signing.at(-1).record.transactionBase64,signedBytes);
  assert.ok(VersionedTransaction.deserialize(Buffer.from(signedBytes,'base64')).signatures.every(signature=>signature.some(byte=>byte!==0)));
  assert.equal(signed.orders.find(order=>order.version===2).items[0].attempts[0].state,'unknown');
  assert.equal(signed.orders.find(order=>order.version===1).revision,0);
  assert.equal(await button('send').isDisabled(),true);assert.equal(await button('sign').isDisabled(),true);
  report.cases.push('byte-accurate hidden #1000 buyer quote and explicit cap/consent precede the synthetic wallet response; native/wallet each sign once, send gate remains disabled');

  const requests=httpRoutes.length,rpc=fixture.calls.length;await context.close();context=null;await runtime.stop();await runtime.start();await launch();
  assert.deepEqual(await counters(),before);assert.equal(httpRoutes.length,requests);assert.equal(fixture.calls.length,rpc);
  await button('orders').selectOption(id);await click('resume-order');assert.deepEqual(await journal(),signed);
  assert.equal(await button('cost-consent').isChecked(),false);assert.equal(await button('sign').isDisabled(),true);assert.equal(await button('send').isDisabled(),true);
  assert.equal(await page.evaluate(s=>integration.wrongProfile(s),hiddenScope),'ORDER_STORAGE_PROFILE_MISMATCH');
  assert.deepEqual(await journal(),signed);assert.equal(httpRoutes.length,requests);
  report.cases.push('full Chromium/SQLite restart retains both modes and the exact signed evidence; unknown outcome cannot trigger another signature or dispatch and wrong commitment restore remains blocked');
  assert.equal(httpRoutes.includes('/api/buyer/send'),false);assert.equal(fixture.calls.some(call=>call.method==='sendTransaction'),false);
  assert.deepEqual(httpRoutes,['/api/buyer/prepare','/api/buyer/check','/api/buyer/check']);
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.httpFailures,[]);assert.equal(report.externalRequests,0);
  report.buyerQuoteLamports=total.toString();report.simulatedMintIndex=1000;report.nativeTransactionSignatures=before.native;report.syntheticWalletSignatures=before.wallet;report.passed=true;
}finally{
  report.httpRoutes=httpRoutes;report.upstreamCalls=fixture.calls.length;report.fixtureSubmissions=fixture.calls.filter(call=>call.method==='sendTransaction').length;report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await runtime.stop();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true});
}
