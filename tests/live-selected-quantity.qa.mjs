import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium,webkit,firefox,devices}=await import(process.env.COOLBEARS_PLAYWRIGHT);
const origin='https://coolbears-nfts.com';
const worker=process.env.QA_WORKER_VERSION;
const headers=worker?{'Cloudflare-Workers-Version-Overrides': 'coolbears-site-candidate="'+worker+'"'}:{};
const engine=process.env.QA_ENGINE??'chromium';
const browser=await ({chromium,webkit,firefox})[engine].launch({headless:true});
const ctx=await browser.newContext({...(engine==='webkit'?devices['iPhone 13']:engine==='firefox'?{viewport:{width:393,height:800},hasTouch:true}:devices['Pixel 7']),locale:'en-US',serviceWorkers:'block',extraHTTPHeaders:headers});
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
async function openQuantity(n,reuse){
  const page=reuse??await ctx.newPage();
  if(!reuse)await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('dialog.public-mint-dialog').waitFor({state:'attached',timeout:60000});
  while(Number(await page.locator('#qty').inputValue())<n)await page.locator('#plus').click();
  await page.locator('#mintBtn').click();
  try{await page.locator(quote).waitFor({timeout:125000});}catch(e){
    console.log('checkout message',await page.locator('[data-view=message]').textContent(),await page.locator('#minted').textContent());throw e;
  }
  assert.equal(await page.locator('#qty').inputValue(),String(n));
  assert.match(await page.locator('[data-view=progress]').textContent(),new RegExp('0 of '+n+'$'));
  const amounts=await page.locator(quote).innerText();
  assert.match(amounts,/0\.200000000 SOL/);
  assert.equal((await page.locator('#total').textContent()).trim(),n===2?'0.4':'0.2');
  if(n===2)assert.match(amounts,/Order estimate/);
  console.log(engine,'quantity',n,'amounts',amounts.replace(/\s+/g,' '));
  return page;
}
async function approve(page,expected){
  await page.locator(action).click();
  for(let i=0;i<85&&calls<expected;i++)await page.waitForTimeout(400);
  if(calls!==expected)console.log('approval message',await page.locator('[data-view=message]').textContent());
  assert.equal(calls,expected,'approval must open the wallet exactly once');
}
try{
  const versionCheck=await ctx.request.get(origin+'/api/buyer/readiness');
  console.log('readiness',versionCheck.status(),(await versionCheck.json()).status);
  let page=await openQuantity(1);const first=await ids(page);assert.equal(first.length,1);
  const before=calls;
  const interrupted=process.env.QA_INTERRUPTED==='1';
  if(interrupted){await approve(page,before+1);await page.close();page=undefined;}
  else await page.locator('[data-action=close]').click();
  const next=await openQuantity(2,page);const nextIds=await ids(next);
  assert.equal(nextIds.length,2);assert.equal(nextIds[0],first[0]);assert.notEqual(nextIds[1],first[0]);
  assert.equal(calls,before+Number(interrupted));
  await approve(next,before+Number(interrupted)+1);assert.equal(blocked,0);
  assert.equal(traces.some(x=>/recover|expiry|replace/.test(x[0])),false);
  console.log('SELECTED_QUANTITY_PASS',JSON.stringify({engine,interrupted,prompts:calls,submitted:0}));
}finally{await browser.close();}
