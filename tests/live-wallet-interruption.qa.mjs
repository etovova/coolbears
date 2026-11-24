import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium,devices}=await import(process.env.COOLBEARS_PLAYWRIGHT);
const origin='https://coolbears-nfts.com';
const worker=process.env.QA_WORKER_VERSION;
const headers=worker?{'Cloudflare-Workers-Version-Overrides': 'coolbears-site-candidate="'+worker+'"'}:{};
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({...devices['Pixel 7'],locale:'en-US',serviceWorkers:'block',extraHTTPHeaders:headers});
let calls=0,blocked=0;const traces=[];
const allowed=new Set(['prepare','check','recover-response','review-response-expiry','replace-response-expiry']);
await ctx.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());
 if(u.origin!==origin)return route.abort();
 if(!['GET','HEAD'].includes(req.method())&&!allowed.has(u.pathname.split('/').pop())){blocked++;console.log('blocked route',u.pathname);return route.abort();}
 return route.continue();
});
ctx.on('response',async res=>{
 const path=new URL(res.url()).pathname;if(!path.startsWith('/api/buyer/'))return;
 const json=await res.json().catch(()=>({}));const r=json.report??json;
 const row=[path.split('/').pop(),res.status(),r.status,r.code??'',res.headers()['retry-after']??''];
 traces.push(row);console.log('endpoint',...row);
});
await ctx.exposeBinding('recordPrompt',()=>{calls++;console.log('WALLET PROMPT',calls);});
await ctx.addInitScript(()=>{const address="FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y";let n=0n;for(const c of address)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const pub=new Uint8Array(32);for(let i=31;i>=0;i--){pub[i]=Number(n&255n);n>>=8n;}const account={address,publicKey:pub,chains:['solana:mainnet'],features:['solana:signTransaction']};const wallet={name:'Read-only QA',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',version:'1.0.0',chains:account.chains,accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async input=>{const tx=input.transaction;if(tx[0]!==2||tx.slice(1,129).some(Boolean))throw Error('EXPECTED_TWO_EMPTY_SIGNATURES');await window.recordPrompt();return new Promise(()=>{});}}}};window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:({register})=>register(wallet)}));});
const ids=page=>page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('coolbears:private-buyer-index:')))).orders.map(o=>o.id));
const quote='dialog[open] [data-view=quote] dl', action='dialog[open] [data-action=mint]';
async function open(){const p=await ctx.newPage();await p.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});await p.locator('dialog.public-mint-dialog').waitFor({state:'attached',timeout:70000});await p.locator('#mintBtn').tap();return p;}
async function orderEvidence(page,id) {
 return page.evaluate(async id=>{
  const db=await new Promise((ok,no)=>{const q=indexedDB.open('coolbears-buyer-custody-v1');q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);});
  try {const tx=db.transaction(['orders','signing'],'readonly');
   const all=store=>new Promise((ok,no)=>{const q=tx.objectStore(store).openCursor(),rows=[];q.onsuccess=()=>{const c=q.result;if(!c){ok(rows);return;}
    const key=Array.isArray(c.key)?c.key[0]:c.key;if(JSON.parse(key).id===id)rows.push(c.value);c.continue();};q.onerror=()=>no(q.error);});
   const [orders,signing]=await Promise.all([all('orders'),all('signing')]);return {orders,signing};
  } finally {db.close();}
 },id);
}
try{
  const proof=await ctx.request.get(origin+'/api/buyer/deployment',{timeout:30000});
  assert.equal(proof.status(),200);assert.equal((await proof.json()).buildSha256,'e916f0275cf10e4953f8e9c80558d0397394e9fb86e522e18ab3e984caa7f5d9');
 const asset='public-mainnet/modules/c0b4bcd4974224d3cb18.mjs';
 const probe=await ctx.request.get(origin+'/'+asset,{timeout:30000});assert.equal(probe.status(),200);assert.equal(await probe.text(),await readFile(asset,'utf8'));console.log('exact readiness module');
 let p=await open();await p.locator(quote).waitFor({timeout:90000});const order=await ids(p);assert.equal(order.length,1);
 await p.waitForTimeout(1150);await p.locator(action).tap();
 for(let i=0;i<30&&calls===0;i++)await p.waitForTimeout(500);
 if(calls===0)console.log('initial wallet state',await p.locator('dialog [data-view=message]').textContent());
 assert.equal(calls,1,'consent must reach the sign-only stub');
 const before=await orderEvidence(p,order[0]);
 assert.deepEqual(before.signing.map(x=>x.phase),['claimed','ready','wallet-claimed']);
 assert.equal(before.orders[0].items[0].attempts[0].signature,null);
 assert.equal(before.signing[1].record.kind,'coolbears-buyer-unsigned');await p.close();
 console.log('tab closed while wallet was waiting; no private key or signed bytes exist');
 if (process.env.QA_REOPEN_IMMEDIATELY !== '1') await new Promise(resolve=>setTimeout(resolve,145000));
 p=await open();
 await p.locator(quote).waitFor({timeout:90000});const now=await ids(p);
 assert.equal(now.length,2);assert.equal(now[0],order[0]);assert.notEqual(now[1],order[0]);
 assert.deepEqual(await orderEvidence(p,order[0]),before);
 const fresh=await orderEvidence(p,now[1]);assert.deepEqual(fresh.signing.map(x=>x.phase),['claimed','ready']);
 assert.equal(fresh.orders[0].quantity,1);assert.equal(fresh.orders[0].items[0].attempts[0].signature,null);
 assert.equal(calls,1);assert.equal(blocked,0);assert.ok(traces.every(x=>x[0]!=='send'));
 console.log('PASS: interrupted sign-only prompt retained without signed response or send, new quote is ready, no second wallet request.');
}finally{await browser.close();}
