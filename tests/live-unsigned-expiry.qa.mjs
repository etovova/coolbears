import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
const {chromium,devices}=await import(process.env.COOLBEARS_PLAYWRIGHT);
const browser=await chromium.launch({headless:true});const origin='https://coolbears-nfts.com';
const ctx=await browser.newContext({...devices['Pixel 7'],locale:'en-US',serviceWorkers:'block'});
if(process.env.QA_WORKER_VERSION)await ctx.setExtraHTTPHeaders({'Cloudflare-Workers-Version-Overrides':'coolbears-site-candidate="'+process.env.QA_WORKER_VERSION+'"'});
const payments=[],trace=[];let signatures=0;
await ctx.exposeBinding('qaSignature',()=>{signatures++;throw Error('Signing is forbidden in this checkout test');});
await ctx.route('**/*',async r=>{const req=r.request(),url=new URL(req.url());
 if(url.origin!==origin)return r.abort();
 if(req.method()!=='GET'&&!['/api/buyer/prepare','/api/buyer/check','/api/buyer/review-prewallet-expiry','/api/buyer/replace-prewallet-expiry','/api/buyer/recover-prewallet'].includes(url.pathname)){payments.push(url.pathname);return r.abort();}
 return r.continue();});
ctx.on('response',async r=>{const path=new URL(r.url()).pathname;if(!path.startsWith('/api/buyer/'))return;
 const body=await r.json().catch(()=>({})),a=body.report??body;trace.push([path,r.status(),a.status,a.code,r.headers()['retry-after'],r.headers()['x-coolbears-readiness-reason'],a.phase,Date.now()]);});
await ctx.addInitScript(()=>{const address="FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y";let n=0n;for(const c of address)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const pub=new Uint8Array(32);for(let i=31;i>=0;i--){pub[i]=Number(n&255n);n>>=8n;}const account={address,publicKey:pub,chains:['solana:mainnet'],features:['solana:signTransaction']};const wallet={name:'Read-only QA',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',version:'1.0.0',chains:account.chains,accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async()=>window.qaSignature()}}};window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:({register})=>register(wallet)}));});
const checkout=async()=>{const page=await ctx.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('dialog.public-mint-dialog').waitFor({state:'attached'});await page.locator('#mintBtn').click();try{await page.locator('dialog[open] [data-view=quote] dl').waitFor({timeout:200000});}catch(e){console.log('result',await page.locator('dialog [data-view=message]').textContent());throw e;}
assert.deepEqual(await page.locator('dialog [data-action]').evaluateAll(xs=>xs.map(n=>n.dataset.action)),['close','mint']);const quote=await page.locator('dialog [data-view=quote] dl').innerText();assert.match(quote,/0\.200000000 SOL/);const ids=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('coolbears:private-buyer-index:')))).orders.map(x=>x.id));await page.close();return ids;};
try{const asset='public-mainnet/modules/c0b4bcd4974224d3cb18.mjs',expected=await readFile(asset,'utf8');let deployed=false;
for(let poll=0;poll<25;poll++){const response=await ctx.request.get(origin+'/'+asset);if(response.ok()&&await response.text()===expected){deployed=true;break;}if(poll<24)await new Promise(r=>setTimeout(r,12000));}
assert.ok(deployed,'exact deployed readiness module did not arrive');const meta=await ctx.request.get(origin+'/metadata/hidden-indexed/9999.json');assert.equal(meta.status(),200);assert.equal((await meta.json()).name,'CoolBears #9999 — Hidden Bear');const one=await checkout();assert.equal(one.length,1);console.log('Fresh quote displayed, closing tab before wallet signature.');await new Promise(r=>setTimeout(r,145000));const ids=await checkout();assert.deepEqual(ids,one);assert.ok(trace.some(x=>x[0].endsWith('/check')&&x[1]===409));assert.ok(trace.some(x=>x[0].endsWith('/review-prewallet-expiry')&&x[2]==='prewallet-expired'));assert.ok(trace.some(x=>x[0].endsWith('/replace-prewallet-expiry')&&x[1]===200));const preparations=trace.filter(x=>x[0].endsWith('/prepare'));assert.equal(preparations.filter(x=>x[1]===200&&x[2]==='prepared').length,1,'exactly one preparation accepted');assert.ok(preparations.every(x=>x[1]===200||x[1]===429&&['BUSY','COOLDOWN'].includes(x[3])),'only bounded rejections before acceptance');console.log('Replacement quote displayed; closing before any signature and awaiting its actual expiry.');
 await new Promise(r=>setTimeout(r,145000));
 const page=await ctx.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'});
 const action=page.locator('dialog[open] [data-action=mint]'),dialog=page.locator('dialog[open]');
 await page.locator('#plus').click();await page.locator('#mintBtn').click();
 await page.getByText('Previous order expired without a payment.',{exact:false}).waitFor({timeout:205000});assert.equal(await action.isVisible(),true);
 assert.equal(await page.locator('#qty').inputValue(),'2');assert.equal(trace.filter(x=>x[0].endsWith('/review-prewallet-expiry')&&x[2]==='prewallet-expired').length,2);
 await page.close();
 const newer=await ctx.newPage();await newer.goto(origin,{waitUntil:'domcontentloaded'});
 await newer.locator('#plus').click();await newer.locator('#mintBtn').click();
 await newer.locator('dialog[open] [data-view=quote] dl').waitFor({timeout:200000});
 assert.equal(await newer.locator('#qty').inputValue(),'2');assert.match(await newer.locator('[data-view=progress]').textContent(),/0 of 2/);assert.match(await newer.locator('[data-view=quote] dl').innerText(),/Order estimate/);
 const orders=await newer.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('coolbears:private-buyer-index:')))).orders.map(x=>x.id));
 assert.equal(orders.length,2);assert.ok(orders.includes(one[0]));assert.equal(new Set(orders).size,2);await newer.close();
 const resumed=await checkout();assert.deepEqual(resumed,orders);
 assert.equal(trace.filter(x=>x[0].endsWith('/replace-prewallet-expiry')&&x[1]===200).length,1);
 assert.equal(signatures,0);assert.deepEqual(payments,[]);console.log('PASS: two finalized expiries; old 1 NFT order preserved, fresh 2 NFT quote and reload, no duplicate order, signatures or sends.');
}finally{console.log(JSON.stringify({trace,signatures,payments}));await browser.close();}