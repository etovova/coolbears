// Native browser signing with disposable keys. Network is loopback fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-asset-signing-fixture-'));
const output=path.resolve('operator/build/buyer-signing-chromium');await mkdir(output,{recursive:true});
const bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-signing-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,inject:['scripts/browser-buffer.mjs']});
const bytes=await readFile(bundle);
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable asset signing fixture</title><script type="module" src="/fixture.js"></script>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const key=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)),address=n=>key(n).publicKey.toBase58();
const buyer=key(1),scope={id:'partial',cluster:'devnet',buyer:address(1),machine:address(2),collection:address(3),guard:address(4)};
const block={blockhash:address(5),lastValidBlockHeight:2000};
const report={passed:false,engine:'chromium',realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,cases:[],pageErrors:[],externalRequests:0};
let context,page;
async function tab(){const p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));await p.goto(origin);await p.waitForFunction(()=>window.store);return p;}
async function launch(){context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});page=await tab();}
async function create(s,quantity=1){return page.evaluate(async({s,quantity,block})=>{window.auditScope=s;const order=await store.create({...s,quantity,available:9999});return candidate(order,block);},{s,quantity,block});}
async function prepare(s,c){return page.evaluate(({s,c})=>{window.auditScope=s;return store.prepareAssetSigning(s,c);},{s,c});}
async function stats(){return page.evaluate(()=>({attempts:assetSignAttempts,signatures:assetSignatures,observations:persistedBeforeSign}));}
async function read(p,s,method='readAssetSigning'){
  const until=Date.now()+5000;let result;
  do{result=await p.evaluate(async({s,method})=>{try{return {value:await store[method](s)};}catch(e){return {error:e.message};}},{s,method});if(result.error!=='ORDER_BUSY')break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<until);
  assert.equal(result.error,undefined);return result.value;
}
try{
  await launch();
  const legacy={...scope,id:'legacy',quantity:1,available:9999};
  const old=await page.evaluate(s=>seedLegacy(s),legacy);
  assert.equal(await page.evaluate(s=>code(store.read(s)),legacy),'STORAGE_UNAVAILABLE');
  await page.evaluate(()=>{legacyConnection.close();store=makeStore();});
  assert.deepEqual(await read(page,legacy,'read'),old);
  assert.equal(await read(page,legacy),null);
  const schema=await page.evaluate(async()=>{const r=indexedDB.open('coolbears-buyer-custody-v1');return new Promise(resolve=>{r.onsuccess=()=>{const db=r.result;resolve({version:db.version,stores:[...db.objectStoreNames]});db.close();};});});
  assert.deepEqual(schema,{version:2,stores:['events','keys','orders','signing']});
  report.cases.push('blocked schema upgrade fails closed; v1 order/history/native key retained exactly after v2 additive upgrade');

  const c=await create(scope,50),saved=await prepare(scope,c);
  assert.equal(saved.status,'asset-partial-saved');assert.equal(saved.readyToSign,false);assert.equal(saved.readyToSubmit,false);
  assert.deepEqual(await stats(),{attempts:1,signatures:1,observations:[{revision:1,state:'wallet-pending',phases:['claimed']}]});
  const partial=VersionedTransaction.deserialize(Buffer.from(saved.request.transactionBase64,'base64'));
  assert.ok(partial.signatures[0].every(x=>x===0));assert.ok(partial.signatures[1].some(Boolean));
  partial.sign([buyer]);const response={transactionBase64:Buffer.from(partial.serialize()).toString('base64')};
  const verified=await page.evaluate(async({scope,saved,response})=>verifyBuyerSigningResponse(await store.read(scope),saved.claim,saved.request,response),{scope,saved,response});
  assert.equal(verified.readyToSubmit,false);assert.equal(verified.orderRevision,1);
  // Discard the caller's completion and restart the whole browser profile.
  await context.close();context=null;await launch();
  assert.deepEqual(await read(page,scope),saved);assert.equal((await stats()).attempts,0);
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:scope,c}),'STALE_REVISION');
  assert.equal((await stats()).attempts,0);
  report.cases.push('exact first message of 50-item order signed once only after durable intent; buyer response verified; full restart returns identical partial bytes without re-signing');

  const altered={...scope,id:'altered'},bad=await create(altered);
  const changed=VersionedTransaction.deserialize(Buffer.from(bad.transactionBase64,'base64'));changed.message.compiledInstructions[0].data[1]^=1;
  const alteredInput={...bad,transactionBase64:Buffer.from(changed.serialize()).toString('base64')};
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:altered,c:alteredInput}),'ORDER_MESSAGE_MISMATCH');
  assert.equal((await read(page,altered,'read')).revision,0);assert.equal(await read(page,altered),null);assert.equal((await stats()).attempts,0);
  report.cases.push('tampered unsigned message rejected before any signing intent or native transaction signature');

  const abort={...scope,id:'claim-abort'},ca=await create(abort);
  await page.evaluate(()=>window.writeFailure='claimed');
  assert.notEqual(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:abort,c:ca}),'UNEXPECTED_SUCCESS');
  await page.evaluate(()=>window.writeFailure=null);
  assert.equal((await read(page,abort,'read')).revision,0);assert.equal(await read(page,abort),null);assert.equal((await stats()).attempts,0);
  report.cases.push('failed atomic claim rolls back order/history/claim and never calls native transaction signer');

  const failed={...scope,id:'native-failure'},cf=await create(failed);
  await page.evaluate(()=>window.signMode='fail');
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:failed,c:cf}),'ASSET_SIGNING_FAILED');
  await page.evaluate(()=>window.signMode=null);
  assert.equal((await read(page,failed)).status,'asset-signing-unknown');assert.equal((await stats()).signatures,0);
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:failed,c:cf}),'STALE_REVISION');
  report.cases.push('native signer failure retains consumed claim and blocks automatic signing retry');

  const lost={...scope,id:'result-abort'},cl=await create(lost);
  await page.evaluate(()=>window.writeFailure='ready');
  assert.notEqual(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:lost,c:cl}),'UNEXPECTED_SUCCESS');
  await page.evaluate(()=>window.writeFailure=null);
  assert.equal((await stats()).signatures,1);assert.equal((await read(page,lost)).status,'asset-signing-unknown');
  await page.reload();await page.waitForFunction(()=>window.store);
  assert.equal((await read(page,lost)).status,'asset-signing-unknown');assert.equal((await stats()).attempts,0);
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:lost,c:cl}),'STALE_REVISION');assert.equal((await stats()).attempts,0);
  report.cases.push('failure after native signature but before result commit releases no partial result; reload retains unresolved claim and never re-signs');

  const crash={...scope,id:'tab-crash'},cc=await create(crash);await page.evaluate(()=>window.signMode='hold');
  const signing=prepare(crash,cc).then(()=>null,error=>error.message);
  await page.waitForFunction(()=>window.signEntered);
  const second=await tab();
  assert.equal(await second.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:crash,c:cc}),'ORDER_BUSY');
  await page.close();await signing;page=second;
  assert.equal((await read(page,crash)).status,'asset-signing-unknown');assert.equal((await stats()).attempts,0);
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:crash,c:cc}),'STALE_REVISION');
  report.cases.push('second tab cannot sign while claim owner is active; closing signing tab preserves unresolved intent without releasing it for another signature');

  await page.evaluate(async s=>raw(['signing'],'readwrite',tx=>{const key=[scopeKey(s),0,1,1];const r=tx.objectStore('signing').get(key);r.onsuccess=()=>tx.objectStore('signing').put({...r.result,record:{...r.result.record,transactionBase64:'AAAA'}},key);return r;}),scope);
  assert.notEqual(await page.evaluate(s=>code(store.readAssetSigning(s)),scope),'UNEXPECTED_SUCCESS');
  assert.notEqual(await page.evaluate(s=>code(store.read(s)),scope),'UNEXPECTED_SUCCESS');assert.equal((await stats()).attempts,0);
  report.cases.push('corrupt persisted partial bytes block recovery and order reads without replacement, clearing or re-signing');
  assert.equal(report.externalRequests,0);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}finally{
  report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true}); // this test's disposable profile only
}
