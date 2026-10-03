// Real Chromium custody and Wallet Standard coordinator; synthetic trusted
// check/send/recovery adapters only. No HTTP gateway or live-chain claim here.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {Keypair} from '@solana/web3.js';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-sequential-fixture-'));
const output=path.resolve('operator/build/buyer-sequential-chromium');await mkdir(output,{recursive:true});
const bundle=path.join(parent,'fixture.js');
await build({entryPoints:['operator/tests/fixtures/buyer-sequential-browser.mjs'],bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,inject:['scripts/browser-buffer.mjs']});
const bytes=await readFile(bundle);
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bytes);}else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Disposable sequential buyer fixture</title><script type="module" src="/fixture.js"></script>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const address=n=>Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const base={cluster:'devnet',buyer:address(1),machine:address(2),collection:address(3),guard:address(4)},block={blockhash:address(5),lastValidBlockHeight:2000};
const report={passed:false,engine:'chromium',realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,
  trustedChecks:'synthetic fixture; real gateway tested separately',persistencePermission:'fixture only',cases:[],pageErrors:[],externalRequests:0};
let context,page;
async function launch(){
  context=await playwright.chromium.launchPersistentContext(path.join(parent,'profile'),{headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.openSequenceClient);
}
async function create(id,quantity=2){const scope={...base,id};await page.evaluate(s=>store.create({...s,quantity:s.quantity,available:9999}),{...scope,quantity});return scope;}
async function prepare(scope,index){return page.evaluate(async({scope,index,block})=>{window.auditScope=scope;const order=await store.read(scope);return store.prepareAssetSigning(scope,candidate(order,block,index));},{scope,index,block});}
async function open(scope){await page.evaluate(scope=>openSequenceClient(scope),scope);await page.evaluate(scope=>openSequenceSender(scope),scope);}
async function sign(scope){await open(scope);const quote=await page.evaluate(()=>approveSequenceCost());const saved=await page.evaluate(()=>client.signOnly(sequenceConsent));return{quote,saved};}
async function complete(scope,index){const prepared=await prepare(scope,index),signed=await sign(scope);assert.equal((await page.evaluate(()=>sender.sendOnce({authorizeDevnetSend:true}))).status,'accepted');assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');return{prepared,...signed};}
const audit=()=>page.evaluate(()=>sequenceAudit);
try{
  await launch();
  const scope=await create('fifty-items',50);
  assert.equal(await page.evaluate(s=>store.readBuyerResponseReplacement(s),scope),null);
  assert.equal(await page.evaluate(s=>store.readPrewalletReplacement(s),scope),null);
  const first=await prepare(scope,0),firstSigned=await sign(scope),oldConsent=await page.evaluate(()=>sequenceConsent);
  assert.equal(firstSigned.quote.version,1);assert.equal(first.claim.asset,(await page.evaluate(s=>store.read(s),scope)).items[0].asset);
  assert.equal((await page.evaluate(()=>sender.sendOnce({authorizeDevnetSend:true}))).status,'accepted');
  await page.evaluate(()=>window.sequenceUnknown=true);
  assert.equal((await page.evaluate(()=>sender.recover())).status,'unknown');
  const beforeUnknown=await audit();
  await assert.rejects(prepare(scope,1));
  assert.equal(await page.evaluate(()=>code(sender.sendOnce({authorizeDevnetSend:true}))),'SEND_NOT_READY');
  assert.equal(await page.evaluate(()=>code(client.signOnly(sequenceConsent))),'NOT_READY');
  assert.deepEqual(await audit(),beforeUnknown);
  report.cases.push('unknown first outcome blocks next item, a second send and a second wallet invocation without creating another native signature');

  await page.evaluate(()=>window.sequenceUnknown=false);assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');
  const firstHistory=await page.evaluate(s=>store.readBuyerAttempt(s,1,0),scope),firstAudit=await audit();
  assert.equal(firstHistory.submission.status,'verified');
  await context.close();context=null;await launch();
  assert.deepEqual(await page.evaluate(s=>store.readBuyerAttempt(s,1,0),scope),firstHistory);
  await open(scope);assert.equal((await page.evaluate(()=>client.state())).canRequestSignature,false);assert.equal((await audit()).native.length,0);
  assert.notEqual(await page.evaluate(async({s,c,block})=>code(store.prepareAssetSigning(s,{...block,itemIndex:1,orderRevision:(await store.read(s)).revision,transactionBase64:c.transactionBase64})),{s:scope,c:first.claim,block}),'UNEXPECTED_SUCCESS');
  assert.equal((await audit()).native.length,0);
  const second=await prepare(scope,1);assert.equal(second.claim.itemIndex,1);assert.notEqual(second.claim.asset,first.claim.asset);
  await open(scope);const secondQuote=await page.evaluate(()=>approveSequenceCost());
  assert.equal(secondQuote.version,2);assert.equal(secondQuote.budget.completedQuantity,1);assert.equal(secondQuote.budget.remainingQuantity,49);
  assert.equal(secondQuote.budget.projectedRemainingTotalLamports,String(BigInt(secondQuote.budget.totalLamports)*49n));
  assert.notEqual(secondQuote.quoteId,firstSigned.quote.quoteId);
  assert.equal(await page.evaluate(c=>code(client.signOnly(c)),oldConsent),'COST_APPROVAL_REQUIRED');
  assert.equal((await audit()).wallet.length,0);
  assert.equal((await audit()).native.length,1);
  assert.equal((await page.evaluate(()=>client.signOnly(sequenceConsent))).status,'buyer-response-saved');
  assert.equal(await page.evaluate(({s,r})=>code(store.saveBuyerResponse(s,{claimId:r.claim.claimId,transactionBase64:r.response.transactionBase64})),{s:scope,r:firstSigned.saved}),'WALLET_CLAIM_MISMATCH');
  assert.equal((await page.evaluate(()=>sender.sendOnce({authorizeDevnetSend:true}))).status,'accepted');
  assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');
  report.cases.push('restart after verified item preserves exact evidence; item 2 uses its own key and version 2 remaining-budget quote, rejects old quote/claim/unsigned bytes and invokes a fresh wallet exactly once');

  const sequenceStarted=Date.now();
  for(let index=2;index<50;index++){
    const completed=await complete(scope,index);
    assert.equal(completed.prepared.claim.itemIndex,index);assert.equal(completed.quote.version,2);
    assert.equal(completed.quote.budget.remainingQuantity,50-index);
    if((index+1)%10===0)console.log(`sequential fixture: ${index+1}/50 persisted, ${Date.now()-sequenceStarted}ms`);
  }
  const order=await page.evaluate(s=>store.read(s),scope),laterAudit=await audit();
  assert.equal(order.quantity,50);assert.ok(order.items.every(item=>item.attempts.length===1&&item.attempts[0].state==='verified'));
  for(const field of ['native','wallet','send']){
    const rows=[...firstAudit[field],...laterAudit[field]].filter(row=>row.id===scope.id);
    assert.equal(rows.length,50,field);assert.deepEqual(rows.map(row=>row.itemIndex),Array.from({length:50},(_,i)=>i));
    if(field==='native')assert.deepEqual(rows.map(row=>row.asset),order.items.map(item=>item.asset));
  }
  assert.equal(new Set([...firstAudit.wallet,...laterAudit.wallet].map(row=>row.quoteId)).size,50);
  const retained=await page.evaluate(async s=>{
    const key=scopeKey(s),rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
    const keys=await raw(['keys'],'readonly',tx=>tx.objectStore('keys').getAll(IDBKeyRange.bound([key],[key,[]])));
    return{groups:rows.filter(row=>row.phase==='claimed').map(row=>[row.record.itemIndex,row.record.attempt]),
      keys:keys.map(key=>({index:key.index,asset:key.asset,extractable:key.privateKey.extractable})),first:await store.readBuyerAttempt(s,1,0),last:await store.readBuyerAttempt(s,1,49),cost:await store.readCostSummary(s)};
  },scope);
  assert.deepEqual(retained.groups,Array.from({length:50},(_,i)=>[i,1]));assert.equal(retained.keys.length,50);assert.ok(retained.keys.every(k=>k.extractable===false));
  assert.deepEqual(retained.first,firstHistory);assert.equal(retained.last.submission.status,'verified');assert.equal(retained.last.signing.claim.itemIndex,49);
  assert.equal(retained.cost.verified,50);assert.equal(retained.cost.remaining,0);assert.equal(retained.cost.actualOrderTotalLamports,null);
  // The latest approval is a test input; a fresh browser context has no volatile globals.
  const completedConsent=await page.evaluate(()=>structuredClone(sequenceConsent));
  await context.close();context=null;await launch();
  const restartReadStarted=Date.now();assert.deepEqual(await page.evaluate(s=>store.read(s),scope),order);
  report.completedOrderRestartReadMs=Date.now()-restartReadStarted;
  assert.deepEqual(await page.evaluate(s=>store.readCostSummary(s),scope),retained.cost);
  assert.deepEqual(await page.evaluate(s=>store.readBuyerAttempt(s,1,49),scope),retained.last);
  await open(scope);const completeAudit=await audit();assert.equal((await page.evaluate(()=>client.state())).canRequestSignature,false);
  assert.equal(await page.evaluate(consent=>code(client.signOnly(consent)),completedConsent),'NOT_READY');
  await assert.rejects(prepare(scope,49));assert.deepEqual(await audit(),completeAudit);
  report.sequence={quantity:50,nativeSignatures:50,walletInvocations:50,fixtureSendInvocations:50,uniqueCostApprovals:50,verified:50};
  report.cases.push('all 50 complete with 50 distinct persisted nonextractable asset keys, 50 native signatures, 50 fresh wallet/cost approvals and 50 fixture send claims; a second full browser restart retains the complete order, full history and unknown actual-total accounting, completion cannot sign again');

  const swapped=await create('wrong-item-key');
  await page.evaluate(async s=>{
    const key=scopeKey(s);window.originalKeys=await raw(['keys'],'readonly',tx=>tx.objectStore('keys').getAll(IDBKeyRange.bound([key],[key,[]])));
    await raw(['keys'],'readwrite',tx=>tx.objectStore('keys').put({...originalKeys[1],privateKey:originalKeys[0].privateKey,publicKey:originalKeys[0].publicKey},[key,1]));
  },swapped);
  const count=(await audit()).native.length;await assert.rejects(prepare(swapped,0));assert.equal((await audit()).native.length,count);
  await page.evaluate(s=>raw(['keys'],'readwrite',tx=>tx.objectStore('keys').put(originalKeys[1],[scopeKey(s),1])),swapped);
  assert.equal((await page.evaluate(s=>store.read(s),swapped)).revision,0);
  report.cases.push('swapped later-item private/public key is rejected before any native transaction signature; restoring the exact test key record retains the original untouched order');

  const missing=await create('missing-later-key');await prepare(missing,0);const missingSigned=await sign(missing);
  await page.evaluate(async s=>{
    const key=scopeKey(s);window.retainedLaterKey=await raw(['keys'],'readonly',tx=>tx.objectStore('keys').get([key,1]));
    await raw(['keys'],'readwrite',tx=>tx.objectStore('keys').delete([key,1]));
  },missing);
  assert.equal(await page.evaluate(s=>code(store.read(s)),missing),'ASSET_KEY_MISSING');
  const recovery=await page.evaluate(s=>store.readRecoverySnapshot(s),missing);
  assert.equal(recovery.custody.status,'unavailable');assert.deepEqual(recovery.custody.items.map(i=>i.status),['available','unavailable']);
  assert.equal(recovery.submission.input.response.transactionBase64,missingSigned.saved.response.transactionBase64);
  await assert.rejects(prepare(missing,1));
  await page.evaluate(s=>raw(['keys'],'readwrite',tx=>tx.objectStore('keys').put(retainedLaterKey,[scopeKey(s),1])),missing);
  await page.evaluate(s=>openSequenceSender(s),missing);assert.equal((await page.evaluate(()=>sender.recover())).status,'verified');await prepare(missing,1);
  report.cases.push('missing later key blocks mutable sequence while exact signed first evidence remains read-only; restoring the same disposable key allows verified recovery and next preparation without regenerating custody');

  const corrupt=await create('missing-history');await complete(corrupt,0);
  await page.evaluate(s=>raw(['events'],'readwrite',tx=>tx.objectStore('events').delete([scopeKey(s),1])),corrupt);
  const beforeCorrupt=await audit();assert.notEqual(await page.evaluate(s=>code(store.read(s)),corrupt),'UNEXPECTED_SUCCESS');
  assert.notEqual(await page.evaluate(s=>code(store.readRecoverySnapshot(s)),corrupt),'UNEXPECTED_SUCCESS');await assert.rejects(prepare(corrupt,1));assert.deepEqual(await audit(),beforeCorrupt);
  report.cases.push('erasing the first canonical prepare event blocks both mutable continuation and read-only evidence review; no later item or native signature can skip the missing history');

  const retry=await create('second-item-two-attempts');await complete(retry,0);await prepare(retry,1);await sign(retry);
  assert.equal((await page.evaluate(()=>sender.reviewExpiry({authorizeExpiryReview:true}))).status,'expired');
  const replacement=await page.evaluate(()=>sender.prepareReplacement({authorizeReplacement:true}));
  assert.equal(replacement.candidate.itemIndex,1);
  await page.evaluate(({s,r})=>{window.auditScope=s;return store.prepareReplacementSigning(s,r,{authorizeReplacementSigning:true});},{s:retry,r:replacement});
  await sign(retry);assert.equal((await page.evaluate(()=>sender.reviewExpiry({authorizeExpiryReview:true}))).status,'expired');
  const secondTerminal=await page.evaluate(s=>store.read(s),retry);assert.equal(secondTerminal.items[1].attempts.length,2);
  assert.ok(secondTerminal.items[1].attempts.every(attempt=>attempt.state==='expired'));
  const retryAudit=await audit(),retryWallets=retryAudit.wallet.filter(row=>row.id===retry.id&&row.itemIndex===1),retryNative=retryAudit.native.filter(row=>row.id===retry.id&&row.itemIndex===1);
  assert.deepEqual(retryWallets.map(row=>row.attempt),[1,2]);assert.equal(new Set(retryWallets.map(row=>row.quoteId)).size,2);
  assert.deepEqual(retryNative.map(row=>[row.attempt,row.asset]),[[1,secondTerminal.items[1].asset],[2,secondTerminal.items[1].asset]]);
  assert.equal(await page.evaluate(()=>code(sender.prepareReplacement({authorizeReplacement:true}))),'REPLACEMENT_NOT_READY');await assert.rejects(prepare(retry,1));
  assert.deepEqual(await audit(),retryAudit);assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,1,1),retry)).submission.status,'expired');
  assert.equal((await page.evaluate(s=>store.readBuyerAttempt(s,2,1),retry)).submission.status,'expired');
  report.cases.push('second item can retain two separately consented expired attempts and exact replacement provenance; a third attempt is blocked while both histories remain readable');

  assert.equal(report.externalRequests,0);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}finally{
  report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true});
}
