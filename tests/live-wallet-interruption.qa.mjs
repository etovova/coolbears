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
await ctx.addInitScript(()=>{const address="FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y";let n=0n;for(const c of address)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const pub=new Uint8Array(32);for(let i=31;i>=0;i--){pub[i]=Number(n&255n);n>>=8n;}const account={address,publicKey:pub,chains:['solana:mainnet'],features:['solana:signTransaction']};const wallet={name:'Read-only QA',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',version:'1.0.0',chains:account.chains,accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async()=>{await window.recordPrompt();return new Promise(()=>{});}}}};window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:({register})=>register(wallet)}));});
const ids=page=>page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('coolbears:private-buyer-index:')))).orders.map(o=>o.id));
const quote='dialog[open] [data-view=quote] dl', action='dialog[open] [data-action=mint]';
async function open(){const p=await ctx.newPage();await p.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});await p.locator('dialog.public-mint-dialog').waitFor({state:'attached',timeout:70000});await p.locator('#mintBtn').tap();return p;}
try{
 const asset='public-mainnet/modules/c0b4bcd4974224d3cb18.mjs';
 const probe=await ctx.request.get(origin+'/'+asset,{timeout:30000});assert.equal(probe.status(),200);assert.equal(await probe.text(),await readFile(asset,'utf8'));console.log('exact readiness module');
 let p=await open();await p.locator(quote).waitFor({timeout:90000});const order=await ids(p);assert.equal(order.length,1);
 await p.waitForTimeout(1150);await p.locator(action).tap();
 for(let i=0;i<30&&calls===0;i++)await p.waitForTimeout(500);
 if(calls===0)console.log('initial wallet state',await p.locator('dialog [data-view=message]').textContent());
 assert.equal(calls,1,'consent must reach the sign-only stub');await p.close();
 console.log('tab closed while wallet was waiting; no private key or signed bytes exist');
 if (process.env.QA_REOPEN_IMMEDIATELY !== '1') await new Promise(resolve=>setTimeout(resolve,145000));
 p=await open();
 const msg=p.locator('dialog[open] [data-view=message]');
 const until=Date.now()+200000;
 while(Date.now()<until&&!traces.some(t=>t[0]==='review-response-expiry'&&t[2]==='response-expired'))await p.waitForTimeout(1000);
 console.log('reopen result',await msg.textContent(),await p.locator('[data-view=progress]').textContent());
 assert.ok(traces.some(t=>t[0]==='review-response-expiry'&&t[2]==='response-expired'),'wallet-invoked expiry was not confirmed');
 assert.deepEqual(await ids(p),order);
 assert.equal(calls,1);assert.equal(blocked,0);await p.waitForTimeout(1200);await p.locator(action).tap();
 await p.locator(quote).waitFor({timeout:60000});assert.deepEqual(await ids(p),order);
 assert.equal(calls,1);assert.equal(blocked,0);
 assert.ok(traces.some(t=>t[0]==='replace-response-expiry'&&t[2]==='replacement-prepared'));
 console.log('PASS: opened wallet, closed tab, recovered original order and fresh amount, one prompt, zero signed or sent.');
}finally{await browser.close();}
