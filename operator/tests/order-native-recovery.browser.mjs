// Native browser signing with disposable keys. Network is loopback fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-native-recovery-fixture-'));
const output=path.resolve('operator/build/buyer-native-recovery-chromium');await mkdir(output,{recursive:true});
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
const recover=s=>page.evaluate(s=>store.recoverAssetSigning(s),s);
const recoverError=s=>page.evaluate(s=>code(store.recoverAssetSigning(s)),s);
const rows=s=>page.evaluate(s=>raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
const events=s=>page.evaluate(s=>raw(['events'],'readonly',tx=>tx.objectStore('events').getAll(IDBKeyRange.bound([scopeKey(s)],[scopeKey(s),[]]))),s);
async function aborted(s){const c=await create(s);await page.evaluate(()=>window.writeFailure='ready');
  await assert.rejects(prepare(s,c));await page.evaluate(()=>window.writeFailure=null);return c;}
try{
  await launch();
  const fresh={...scope,id:'unsigned'},candidateBefore=await create(fresh),orderBefore=await read(page,fresh,'read');
  assert.equal(await recover(fresh),null);assert.equal(await recover({...scope,id:'absent'}),null);
  assert.deepEqual(await read(page,fresh,'read'),orderBefore);assert.equal((await stats()).attempts,0);
  report.cases.push('unsigned and absent orders remain unchanged; recovery creates no claim, signature, key or replacement');

  const lost={...scope,id:'retained'},c=await aborted(lost),originalRows=await rows(lost),native=await page.evaluate(()=>lastNativeSignature);
  assert.equal((await stats()).attempts,1);assert.equal((await stats()).signatures,1);
  assert.equal((await read(page,lost)).request,null);
  // Another storage instance/tab has no authority to reconstruct missing bytes.
  const second=await tab();assert.equal((await second.evaluate(s=>store.recoverAssetSigning(s),lost)).status,'asset-signing-unknown');
  assert.equal(await second.evaluate(()=>assetSignAttempts),0);
  await page.evaluate(()=>window.writeFailure='ready');assert.notEqual(await recoverError(lost),'UNEXPECTED_SUCCESS');
  await page.evaluate(()=>window.writeFailure=null);assert.deepEqual(await rows(lost),originalRows);
  const order=await read(page,lost,'read');await page.evaluate(({s,r})=>store.append(s,{type:'pause',revision:r}),{s:lost,r:order.revision});
  const paused=await read(page,lost,'read'),history=await events(lost),recovered=await recover(lost);
  assert.equal(recovered.status,'asset-partial-saved');assert.equal(recovered.readyToSign,false);assert.equal(recovered.readyToSubmit,false);
  assert.equal(recovered.salesOpen,false);assert.deepEqual(await read(page,lost,'read'),paused);assert.deepEqual(await events(lost),history);
  assert.deepEqual(await rows(lost),[...originalRows,{phase:'ready',record:recovered.request}]);
  const wire=VersionedTransaction.deserialize(Buffer.from(recovered.request.transactionBase64,'base64'));
  assert.deepEqual([...wire.signatures[1]],native);assert.ok(wire.signatures[0].every(x=>x===0));
  assert.deepEqual(await second.evaluate(s=>store.recoverAssetSigning(s),lost),recovered);
  assert.equal((await stats()).attempts,1);assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:lost,c}),'STALE_REVISION');
  report.cases.push('original native result survives repeated ready-write aborts in its instance; one strict recovery write preserves pause/order/events and exact signature; other tab cannot reconstruct it');

  const ack={...scope,id:'native-readback-lost'},ca=await create(ack);
  await page.evaluate(()=>window.loseNativeReadback=true);assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:ack,c:ca}),'ASSET_KEY_MISMATCH');
  const ackRows=await rows(ack),ackEvents=await events(ack),writes=await page.evaluate(()=>readyWriteAttempts),signs=(await stats()).attempts;
  const ackState=await recover(ack);assert.equal(ackState.status,'asset-partial-saved');
  assert.deepEqual(await rows(ack),ackRows);assert.deepEqual(await events(ack),ackEvents);
  assert.equal(await page.evaluate(()=>readyWriteAttempts),writes);assert.equal((await stats()).attempts,signs);
  assert.equal(await page.evaluate(s=>code(store.recoverAssetSigning(s).then(()=>{throw Error('LOST_LOCAL_ACK');})),ack),'LOST_LOCAL_ACK');
  assert.deepEqual(await recover(ack),ackState);assert.equal(await page.evaluate(()=>readyWriteAttempts),writes);
  report.cases.push('lost original post-commit readback and lost recovery acknowledgment restore identical saved bytes without another write or transaction signature');

  const failed={...scope,id:'native-no-result'},cf=await create(failed);
  await page.evaluate(()=>window.signMode='fail');await assert.rejects(prepare(failed,cf));await page.evaluate(()=>window.signMode=null);
  const failedRows=await rows(failed),failedCount=(await stats()).attempts;
  assert.equal((await recover(failed)).status,'asset-signing-unknown');assert.deepEqual(await rows(failed),failedRows);
  assert.equal((await stats()).attempts,failedCount);
  report.cases.push('native rejection returns no retained result, keeps consumed claim and never retries signing');

  const corrupt={...scope,id:'native-corrupt-claim'};await aborted(corrupt);const correctRows=await rows(corrupt),beforeCorrupt=(await stats()).attempts;
  await page.evaluate(async s=>raw(['signing'],'readwrite',tx=>{const k=[scopeKey(s),0,1,0],r=tx.objectStore('signing').get(k);
    r.onsuccess=()=>tx.objectStore('signing').put({...r.result,record:{...r.result.record,transactionBase64:'AAAA'}},k);return r;}),corrupt);
  assert.notEqual(await recoverError(corrupt),'UNEXPECTED_SUCCESS');assert.equal((await rows(corrupt)).length,1);assert.equal((await stats()).attempts,beforeCorrupt);
  // Repair only this deliberately corrupted disposable fixture, never production data.
  await page.evaluate(({s,row})=>raw(['signing'],'readwrite',tx=>tx.objectStore('signing').put(row,[scopeKey(s),0,1,0])),{s:corrupt,row:correctRows[0]});
  assert.equal((await recover(corrupt)).status,'asset-partial-saved');assert.equal((await stats()).attempts,beforeCorrupt);
  report.cases.push('corrupt durable claim blocks retained-result recovery and is never overwritten; retained bytes are not discarded on failed validation');

  const competing={...scope,id:'native-active'},cc=await create(competing);await page.evaluate(()=>{window.signMode='hold';window.writeFailure='ready';});
  const pending=prepare(competing,cc).then(()=>null,e=>e.message);await page.waitForFunction(()=>window.signEntered);
  assert.equal(await second.evaluate(s=>code(store.recoverAssetSigning(s)),competing),'ORDER_BUSY');
  await page.evaluate(()=>releaseSigning());assert.ok(await pending);await page.evaluate(()=>{window.signMode=null;window.writeFailure=null;});
  const afterSign=(await stats()).attempts;assert.equal((await recover(competing)).status,'asset-partial-saved');assert.equal((await stats()).attempts,afterSign);
  report.cases.push('exclusive order lock prevents racing recovery during native signing; original returned result is recovered after failed persistence');

  const closed={...scope,id:'native-instance-closed'};await aborted(closed);const closedRows=await rows(closed);
  await page.evaluate(()=>store.close());assert.equal(await recoverError(closed),'STORAGE_UNAVAILABLE');await page.evaluate(()=>{window.store=makeStore();});
  assert.equal((await recover(closed)).status,'asset-signing-unknown');assert.deepEqual(await rows(closed),closedRows);
  report.cases.push('closing the originating storage instance cannot transfer volatile recovery authority to a new instance');

  const vanished={...scope,id:'native-restart-loss'};const cv=await aborted(vanished),vanishedRows=await rows(vanished);
  await context.close();context=null;await launch();
  assert.deepEqual(await recover(lost),recovered);assert.deepEqual(await recover(ack),ackState);
  assert.equal((await recover(vanished)).status,'asset-signing-unknown');assert.deepEqual(await rows(vanished),vanishedRows);
  assert.equal(await page.evaluate(({s,c})=>code(store.prepareAssetSigning(s,c)),{s:vanished,c:cv}),'STALE_REVISION');
  assert.equal((await stats()).attempts,0);
  report.cases.push('full browser restart restores committed partials exactly; uncommitted volatile results remain unknown with no signature, new hash or reset');
  assert.equal(report.externalRequests,0);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}finally{
  report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true});
}
