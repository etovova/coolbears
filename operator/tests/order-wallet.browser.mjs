// Native browser signing with disposable keys. Network is loopback fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-wallet-handoff-fixture-'));
const output=path.resolve('operator/build/buyer-wallet-chromium');await mkdir(output,{recursive:true});
const bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-wallet-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,inject:['scripts/browser-buffer.mjs']});
const bytes=await readFile(bundle);
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable wallet handoff fixture</title><script type="module" src="/fixture.js"></script>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const key=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)),address=n=>key(n).publicKey.toBase58();
const buyer=key(1),scope={id:'partial',cluster:'devnet',buyer:address(1),machine:address(2),collection:address(3),guard:address(4)};
const block={blockhash:address(5),lastValidBlockHeight:2000};
const report={passed:false,engine:'chromium',realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,trustedCheck:'fixture; real RPC adapter tested separately',persistencePermission:'fixture only',cases:[],pageErrors:[],externalRequests:0};
let context,page;
async function tab(){const p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));await p.goto(origin);await p.waitForFunction(()=>window.openClient);return p;}
async function launch(){context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});page=await tab();}
async function create(s,quantity=1){return page.evaluate(async({s,quantity,block})=>{window.auditScope=s;const order=await store.create({...s,quantity,available:9999});return candidate(order,block);},{s,quantity,block});}
async function prepare(s,c){return page.evaluate(({s,c})=>{window.auditScope=s;return store.prepareAssetSigning(s,c);},{s,c});}
async function stats(){return page.evaluate(()=>({attempts:assetSignAttempts,signatures:assetSignatures,observations:persistedBeforeSign}));}
async function read(p,s,method='readAssetSigning'){
  const until=Date.now()+5000;let result;
  do{result=await p.evaluate(async({s,method})=>{try{return {value:await store[method](s)};}catch(e){return {error:e.message};}},{s,method});if(result.error!=='ORDER_BUSY')break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<until);
  assert.equal(result.error,undefined);return result.value;
}
async function setup(id, options={}) {
  const s={...scope,id},c=await create(s);await prepare(s,c);
  await page.evaluate(({s,options})=>openClient(s,options),{s,options});return s;
}
const failure=()=>page.evaluate(()=>code(client.signOnly()));
const calls=()=>page.evaluate(()=>walletCalls);
try{
  await launch();
  const good=await setup('success');
  const result=await page.evaluate(()=>client.signOnly());
  assert.equal(result.status,'buyer-response-saved');assert.equal(result.readyToSubmit,false);
  assert.deepEqual(await page.evaluate(()=>walletObservations),[{revision:2,state:'unknown',phases:['claimed','ready','wallet-claimed']}]);
  assert.equal((await read(page,good,'read')).items[0].attempts[0].state,'unknown');
  assert.equal((await read(page,good,'read')).revision,3);assert.equal(await calls(),1);
  // Whole process restart; saved response and claim survive, no wallet re-entry.
  await context.close();context=null;await launch();
  assert.deepEqual(await read(page,good,'readBuyerResponse'),result);
  await page.evaluate(s=>openClient(s),good);assert.equal(await failure(),'NOT_READY');assert.equal(await calls(),0);
  assert.deepEqual(await page.evaluate(()=>client.recover()),result);
  report.cases.push('exact buyer response committed atomically with signature event; full browser restart recovers identical bytes, unknown state and no repeated wallet call');

  const denied=await setup('persist-denied');await page.evaluate(()=>window.fakePersisted=false);
  assert.equal(await failure(),'PERSISTENT_STORAGE_REQUIRED');assert.equal(await calls(),0);
  assert.equal((await read(page,denied,'read')).revision,1);await page.evaluate(()=>window.fakePersisted=true);
  for(const checkMode of ['expired','altered','account-change']){
    await setup('check-'+checkMode);await page.evaluate(mode=>window.checkMode=mode,checkMode);
    assert.ok(['PREFLIGHT_BLOCKED','WALLET_CHANGED'].includes(await failure()));assert.equal(await calls(),0);
    await page.evaluate(()=>window.checkMode=null);
  }
  const wrong={...scope,id:'wrong-wallet'},cw=await create(wrong);await prepare(wrong,cw);
  assert.equal(await page.evaluate(s=>code(openClient(s,{walletSeed:9})),wrong),'WRONG_WALLET');assert.equal(await calls(),0);
  report.cases.push('denied persistence, stale/mutated check, changed account and wrong wallet block before claim and signing');

  const aborted=await setup('wallet-claim-abort');await page.evaluate(()=>window.writeFailure='wallet-claimed');
  assert.notEqual(await failure(),'UNEXPECTED_SUCCESS');assert.equal(await calls(),0);
  await page.evaluate(()=>window.writeFailure=null);
  assert.equal((await read(page,aborted,'read')).revision,1);assert.equal(await read(page,aborted,'readBuyerResponse'),null);
  report.cases.push('wallet claim quota abort rolls back unknown event and intent together; wallet never invoked');

  for(const mode of ['reject','throw','tamper']){
    const s=await setup('wallet-'+mode);await page.evaluate(mode=>window.walletMode=mode,mode);
    const count=await calls();assert.notEqual(await failure(),'UNEXPECTED_SUCCESS');assert.equal(await calls(),count+1);
    assert.equal((await read(page,s,'readBuyerResponse')).status,'wallet-response-unknown');
    assert.equal((await read(page,s,'read')).revision,2);await page.evaluate(()=>window.walletMode=null);
    assert.equal(await failure(),'NOT_READY');assert.equal(await calls(),count+1);
  }
  report.cases.push('wallet rejection, transport failure and altered message retain unknown intent, reject invalid bytes and never reopen the wallet');

  const failed=await setup('response-abort');await page.evaluate(()=>window.writeFailure='buyer-response');
  const count=await calls();assert.notEqual(await failure(),'UNEXPECTED_SUCCESS');assert.equal(await calls(),count+1);
  assert.equal((await read(page,failed,'read')).revision,2);assert.equal((await read(page,failed,'readBuyerResponse')).response,null);
  await page.evaluate(()=>window.writeFailure=null);
  const recovered=await page.evaluate(()=>client.recover());assert.equal(recovered.status,'buyer-response-saved');
  assert.equal((await read(page,failed,'read')).revision,3);assert.equal(await calls(),count+1);
  report.cases.push('response persistence abort retains verified bytes in memory; recovery stores bytes plus event without another wallet request');

  const unavailable=await setup('storage-after-wallet');await page.evaluate(()=>window.walletMode='storage-unavailable');
  const countUnavailable=await calls();assert.equal(await failure(),'STORAGE_UNAVAILABLE');
  assert.equal(await page.evaluate(()=>client.state().canRecover),true);
  assert.equal((await read(page,unavailable,'read')).revision,2);
  await page.evaluate(()=>{window.storageUnavailable=false;window.walletMode=null;});
  assert.equal((await page.evaluate(()=>client.recover())).status,'buyer-response-saved');
  assert.equal(await calls(),countUnavailable+1);
  report.cases.push('storage becoming unavailable at wallet completion cannot discard cryptographically verified response; recovery saves it without another signature');

  const ack=await setup('lost-ack');await page.evaluate(()=>window.loseAck=true);
  const countAck=await calls();assert.equal(await failure(),'LOST_ACK');
  assert.equal((await read(page,ack,'read')).revision,3);
  await page.evaluate(()=>window.loseAck=false);await page.evaluate(()=>client.recover());
  assert.equal((await read(page,ack,'read')).revision,3);assert.equal(await calls(),countAck+1);
  const storedAck=await read(page,ack,'readBuyerResponse');
  assert.equal(await page.evaluate(({s,r})=>code(store.saveBuyerResponse(s,{claimId:'f'.repeat(64),transactionBase64:r.response.transactionBase64})),{s:ack,r:storedAck}),'WALLET_CLAIM_MISMATCH');
  assert.equal(await page.evaluate(({s,r})=>code(store.saveBuyerResponse(s,{claimId:r.claim.claimId,transactionBase64:'AAAA'})),{s:ack,r:storedAck}),'BUYER_RESPONSE_CONFLICT');
  report.cases.push('lost acknowledgment is idempotent with no duplicate event; foreign claims and conflicting responses rejected');

  const late=await setup('late-response',{walletTimeoutMs:100});await page.evaluate(()=>{window.walletMode='hold';window.walletEntered=false;});
  assert.equal(await failure(),'WALLET_RESPONSE_PENDING');
  assert.equal((await read(page,late,'readBuyerResponse')).response,null);
  await page.evaluate(()=>releaseWallet());
  await page.waitForFunction(()=>client.state().status==='buyer-response-saved');
  assert.equal((await read(page,late,'read')).items[0].attempts[0].state,'unknown');
  await page.evaluate(()=>window.walletMode=null);
  report.cases.push('bounded wallet timeout retains consumed intent; late valid callback saves evidence without enabling send');

  const changed=await setup('account-changed-response');await page.evaluate(()=>window.walletMode='account-change');
  assert.equal((await page.evaluate(()=>client.signOnly())).status,'buyer-response-saved');
  assert.equal((await read(page,changed,'read')).items[0].attempts[0].state,'unknown');await page.evaluate(()=>window.walletMode=null);
  report.cases.push('account change after invocation does not discard the original buyer valid signature; it remains evidence only');

  const crash=await setup('wallet-tab-crash');await page.evaluate(()=>{window.walletMode='hold';window.walletEntered=false;});
  const pending=page.evaluate(()=>client.signOnly()).then(()=>null,e=>e.message);await page.waitForFunction(()=>walletEntered);
  const second=await tab();await second.evaluate(s=>openClient(s),crash);
  assert.equal(await second.evaluate(()=>code(client.signOnly())),'NOT_READY');assert.equal(await second.evaluate(()=>walletCalls),0);
  await page.close();await pending;page=second;
  const afterCrash=await read(page,crash,'readBuyerResponse');assert.equal(afterCrash.status,'wallet-response-unknown');
  assert.equal(await failure(),'NOT_READY');assert.equal(await calls(),0);
  report.cases.push('second tab and closing an active wallet tab cannot reacquire consumed invocation or lose its durable claim');

  await page.evaluate(async s=>raw(['signing'],'readwrite',tx=>{const key=[scopeKey(s),0,1,3];const r=tx.objectStore('signing').get(key);r.onsuccess=()=>tx.objectStore('signing').put({...r.result,record:{...r.result.record,transactionBase64:'AAAA'}},key);return r;}),good);
  assert.notEqual(await page.evaluate(s=>code(store.readBuyerResponse(s)),good),'UNEXPECTED_SUCCESS');
  assert.notEqual(await page.evaluate(s=>code(store.read(s)),good),'UNEXPECTED_SUCCESS');assert.equal(await calls(),0);
  report.cases.push('corrupt saved buyer response blocks all reads without deleting or replacing custody/history');
  assert.equal(report.externalRequests,0);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}finally{
  report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true}); // this test profile only
}
