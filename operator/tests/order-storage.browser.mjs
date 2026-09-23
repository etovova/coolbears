// Disposable loopback browser profile only. No wallet, RPC or transaction bytes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Keypair } from '@solana/web3.js';
const playwright = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const output = path.resolve('operator/build/buyer-storage-chromium');
await mkdir(output, { recursive: true });
const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-storage-fixture-'));
const bundle = path.join(parent, 'fixture.js');
await build({ stdin: { contents: `
  import { createBuyerStorage } from './operator/orders/browser-storage.mjs';
  import { createOrderModel } from './operator/orders/journal-model.mjs';
  import policy from './metadata/policy.json';
  window.makeStore = createBuyerStorage;
  window.store = createBuyerStorage();
  window.model = createOrderModel(policy);
  window.raw = async (names, mode, action) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('coolbears-buyer-custody-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode); let result;
      tx.oncomplete = () => resolve(result?.result); tx.onabort = tx.onerror = () => reject(tx.error);
      result = action(tx);
    }); } finally { db.close(); }
  };
  window.scopeKey = s => JSON.stringify(Object.fromEntries(['id','cluster','buyer','machine','collection','guard'].map(k => [k, s[k]])));
  window.code = async p => { try { await p; return 'UNEXPECTED_SUCCESS'; } catch (e) { return e.message; } };
`, resolveDir: process.cwd(), sourcefile: 'storage-fixture.mjs', loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: bundle,
  inject: [path.resolve('scripts/browser-buffer.mjs')] });
const bytes = await readFile(bundle);
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(bytes); }
  else { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><title>Disposable buyer storage fixture</title><script type="module" src="/fixture.js"></script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { passed: false, engine: 'chromium', realWallets: false, physicalPhones: false, liveRpc: false, transactionsSent: 0, cases: [], pageErrors: [], externalRequests: 0 };
const address = n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const scope = { id: 'fifty', cluster: 'devnet', buyer: address(1), machine: address(2), collection: address(3), guard: address(4) };
const input = { ...scope, quantity: 50, available: 9999 };
let context, page;
async function launch() {
  context = await playwright.chromium.launchPersistentContext(path.join(parent, 'profile'), { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { report.externalRequests++; return route.abort(); }
    return route.continue();
  });
  page = await tab();
}
async function tab() {
  const p = await context.newPage(); p.on('pageerror', e => report.pageErrors.push(e.message));
  await p.goto(origin); await p.waitForFunction(() => window.store); return p;
}
async function read(p, s = scope) { return p.evaluate(s => store.read(s), s); }
async function code(p, method, s, event) { return p.evaluate(({method,s,event}) => window.code(store[method](s,event)), {method,s,event}); }
try {
  await launch();
  const first = await page.evaluate(input => store.create(input), input);
  assert.equal(first.items.length, 50); assert.equal(new Set(first.items.map(i => i.asset)).size, 50);
  const flags = await page.evaluate(async s => {
    const keys = await raw(['keys'], 'readonly', tx => tx.objectStore('keys').getAll(IDBKeyRange.bound([scopeKey(s),0],[scopeKey(s),49])));
    return { count: keys.length, exportDenied: (await Promise.all(keys.map(k => code(crypto.subtle.exportKey('pkcs8', k.privateKey))))).every(v => v !== 'UNEXPECTED_SUCCESS'), nonExtractable: keys.every(k => !k.privateKey.extractable) };
  }, scope);
  assert.deepEqual(flags, { count:50, exportDenied:true, nonExtractable:true });
  await page.reload(); await page.waitForFunction(() => window.store); assert.deepEqual(await read(page), first);
  await context.close(); context = null; await launch(); assert.deepEqual(await read(page), first);
  report.cases.push('50 atomic assets: non-extractable Ed25519 keys survive page reload and full Chromium restart; possession rechecked');

  const prepare = { type:'prepare', revision:0, index:0, blockhash:address(5), lastValidBlockHeight:2000, messageSha256:'a'.repeat(64) };
  await page.evaluate(({scope,event}) => store.append(scope,event), {scope,event:prepare});
  // The application loses its completion acknowledgment after durable storage.
  assert.equal(await page.evaluate(async s => {
    await store.append(s, {type:'unknown',revision:1,index:0,attempt:1}); return 'dropped-ack';
  },scope), 'dropped-ack');
  await page.reload(); await page.waitForFunction(() => window.store);
  const unknown = await read(page); assert.equal(unknown.revision,2); assert.equal(unknown.items[0].attempts[0].state,'unknown');
  assert.deepEqual(await page.evaluate(s => model.nextAction(s), unknown), {type:'reconcile',index:0,attempt:1});
  assert.equal(await code(page,'create',input), 'ORDER_EXISTS');
  assert.equal(await code(page,'append',scope,prepare), 'STALE_REVISION');
  assert.deepEqual((await read(page)).items.map(i=>i.asset), first.items.map(i=>i.asset));
  report.cases.push('lost completion/reload retains unknown attempt, original addresses and history; recreate/stale callback blocked');

  let second = await tab();
  const race = {...input,id:'race',quantity:1};
  const creations = await Promise.all([code(page,'create',race),code(second,'create',race)]);
  assert.equal(creations.filter(v=>v==='UNEXPECTED_SUCCESS').length,1); assert.equal(creations.filter(v=>['ORDER_BUSY','ORDER_EXISTS'].includes(v)).length,1);
  const writes = await Promise.all([code(page,'append',race,{type:'pause',revision:0}),code(second,'append',race,{type:'pause',revision:0})]);
  assert.equal(writes.filter(v=>v==='UNEXPECTED_SUCCESS').length,1); assert.equal(writes.filter(v=>['ORDER_BUSY','STALE_REVISION'].includes(v)).length,1);
  assert.equal((await read(page,race)).revision,1);
  await second.evaluate(s => { window.held = false; navigator.locks.request(`coolbears:buyer-order:v1:${scopeKey(s)}`, async () => { window.held=true; await new Promise(resolve=>window.release=resolve); }); }, race);
  await second.waitForFunction(()=>window.held); assert.equal(await code(page,'read',race),'ORDER_BUSY');
  await second.close(); second = null;
  // Closing the page and release in the browser's lock manager are separate tasks.
  // Wait on read-only lock state, never retry a write or forcibly steal the lock.
  await page.waitForFunction(async s => !(await navigator.locks.query()).held.some(lock => lock.name === `coolbears:buyer-order:v1:${scopeKey(s)}`), race, { timeout: 5000 });
  assert.equal((await read(page,race)).revision,1);
  report.cases.push('two-tab create/CAS competition has one winner; busy lock fails promptly and tab closure releases lock without deleting data');

  const other = {...input,id:scope.id,buyer:address(6),quantity:1};
  await page.evaluate(s=>store.create(s),other); assert.equal((await read(page,other)).buyer,other.buyer); assert.equal((await read(page)).revision,2);
  assert.equal(await code(page,'read',{...scope,collection:address(7)}),'UNEXPECTED_SUCCESS');
  assert.equal(await read(page,{...scope,collection:address(7)}),null);
  assert.equal(await code(page,'create',{...input,cluster:'mainnet-beta'}),'DEVNET_ONLY');
  for (const quantity of [0,51,1.5]) assert.equal(await code(page,'create',{...input,id:'bad',quantity}), 'INVALID_QUANTITY');
  report.cases.push('buyer/deployment scope isolation, Devnet gate and quantity bounds before key creation');

  const fault = {...input,id:'rollback',quantity:2};
  const faultResult = await page.evaluate(async s => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(value,key) {
      if (this.name==='keys' && value.index===1) throw new DOMException('fixture quota','QuotaExceededError');
      return original.call(this,value,key);
    };
    let error; try { error=await code(store.create(s)); } finally { IDBObjectStore.prototype.add=original; }
    const counts=await raw(['orders','keys','events'],'readonly',tx=>tx.objectStore('keys').count(IDBKeyRange.bound([scopeKey(s),0],[scopeKey(s),49])));
    return {error,order:await store.read(s),keys:counts};
  },fault);
  assert.equal(faultResult.order,null); assert.equal(faultResult.keys,0); assert.notEqual(faultResult.error,'UNEXPECTED_SUCCESS');
  await page.evaluate(s=>store.create(s),fault);
  const abortResult=await page.evaluate(async s => {
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key) { const r=original.call(this,value,key); if(this.name==='orders') this.transaction.abort(); return r; };
    try { return await code(store.append(s,{type:'pause',revision:0})); } finally { IDBObjectStore.prototype.put=original; }
  },fault);
  assert.equal(abortResult,'STORAGE_WRITE_FAILED'); assert.equal((await read(page,fault)).revision,0);
  report.cases.push('quota/create failure rolls back keys/order/history together; commit abort never reports success or advances revision');

  const corrupt={...input,id:'corrupt',quantity:2}; await page.evaluate(s=>store.create(s),corrupt);
  await page.evaluate(async s=>raw(['keys'],'readwrite',tx=>{
    const r=tx.objectStore('keys').get([scopeKey(s),0]); r.onsuccess=()=>tx.objectStore('keys').put({...r.result,index:1},[scopeKey(s),1]); return r;
  }),corrupt);
  assert.equal(await code(page,'read',corrupt),'ASSET_KEY_MISSING');
  assert.equal(await code(page,'append',corrupt,{type:'pause',revision:0}),'ASSET_KEY_MISSING');
  const mismatch={...input,id:'mismatch',quantity:2}; await page.evaluate(s=>store.create(s),mismatch);
  await page.evaluate(async s=>raw(['keys'],'readwrite',tx=>{
    const a=tx.objectStore('keys').get([scopeKey(s),0]),b=tx.objectStore('keys').get([scopeKey(s),1]);
    b.onsuccess=()=>tx.objectStore('keys').put({...b.result,privateKey:a.result.privateKey},[scopeKey(s),1]); return b;
  }),mismatch);
  assert.equal(await code(page,'read',mismatch),'ASSET_KEY_MISMATCH');
  const history={...input,id:'history',quantity:1}; await page.evaluate(s=>store.create(s),history);
  await page.evaluate(async s=>raw(['orders'],'readwrite',tx=>{
    const r=tx.objectStore('orders').get(scopeKey(s)); r.onsuccess=()=>tx.objectStore('orders').put({...r.result,paused:true},scopeKey(s)); return r;
  }),history);
  assert.equal(await code(page,'read',history),'CORRUPT_ORDER_HISTORY');
  const missing={...input,id:'missing',quantity:1}; await page.evaluate(s=>store.create(s),missing);
  await page.evaluate(async s=>raw(['keys'],'readwrite',tx=>tx.objectStore('keys').delete([scopeKey(s),0])),missing);
  assert.equal(await code(page,'read',missing),'ASSET_KEY_MISSING');
  assert.equal(await code(page,'create',missing),'ASSET_KEY_MISSING');
  report.cases.push('missing/wrong key identity, mismatched private/public key and modified snapshot block reads/writes without replacing damaged records');

  const unsupported = await page.evaluate(async s => {
    localStorage.setItem(`coolbears:offline-order:v1:${s.id}`,'legacy-fixture-do-not-migrate');
    return { locked:await code(makeStore({locks:null}).read(s)), db:await code(makeStore({indexedDB:null}).read(s)), crypto:await code(makeStore({crypto:null}).read(s)), legacy:localStorage.getItem(`coolbears:offline-order:v1:${s.id}`) };
  },scope);
  assert.deepEqual(unsupported,{locked:'STORAGE_UNAVAILABLE',db:'STORAGE_UNAVAILABLE',crypto:'STORAGE_UNAVAILABLE',legacy:'legacy-fixture-do-not-migrate'});
  assert.deepEqual(await read(page),unknown);
  report.cases.push('missing locks/database/crypto fail closed; legacy localStorage and existing unknown order unchanged');
  assert.equal(report.externalRequests,0); assert.deepEqual(report.pageErrors,[]); report.passed=true;
} finally {
  report.completedAt=new Date().toISOString();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await context?.close(); await new Promise(resolve=>server.close(resolve));
  await rm(parent,{recursive:true,force:true}); // This invocation's disposable test profile only.
}
