import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const engine=process.env.QA_ENGINE??'firefox';
const pw=await import(process.env.COOLBEARS_PLAYWRIGHT);
const config=(await import(pathToFileURL(path.join(process.cwd(),'public-mainnet/deployment.mjs')))).default;
const browser=await pw[engine].launch();
const mime={'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.gif':'image/gif','.json':'application/json'};
try{for(const lang of ['en','ru','zh']){
 const ctx=await browser.newContext({...(engine==='webkit'?pw.devices['iPhone 13']:engine==='chromium'?pw.devices['Pixel 7']:{viewport:{width:1100,height:850}}),serviceWorkers:'block'});
 let calls=0,prepares=0;const forbidden=[];
 await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname;
   if(u.origin!==config.origin)return route.abort();
   if(p==='/api/buyer/readiness'&&req.method()==='GET'){
     const t=Date.now();const body={version:1,status:'open',salesOpen:true,checkedAt:t,expiresAt:t+8500,maximumPerOrder:50,unitPriceLamports:'200000000'};
     for(const k of ['cluster','genesisHash','machine','collection','guard','storageMode','hiddenCommitmentSha256','profileSha256'])body[k]=config[k];
     return route.fulfill({json:body,headers:{'x-coolbears-network-verified':'1'}});
   }
   if(p==='/api/buyer/prepare'&&req.method()==='POST'){
     prepares++;return route.fulfill({status:429,headers:{'retry-after':'27091'},json:{status:'blocked',code:'DAILY_LIMIT'}});
   }
   if(p.startsWith('/api/')||req.method()!=='GET'){forbidden.push([req.method(),p]);return route.abort();}
   const f=path.resolve(p==='/'?'index.html':'.'+p);
   if(!f.startsWith(process.cwd()+'/'))return route.abort();
   try{return await route.fulfill({body:await readFile(f),contentType:mime[path.extname(f)]??'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
await ctx.exposeBinding('recordPrompt',()=>{calls++;});
 await ctx.addInitScript(()=>{
   const publicKey=new Uint8Array(32);publicKey[31]=1;
   const account={address:'11111111111111111111111111111112',publicKey,chains:['solana:mainnet'],features:['solana:signTransaction']};
   const wallet={name:'Local test wallet',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',version:'1.0.0',accounts:[account],chains:account.chains,
     features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},
       'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async()=>{await window.recordPrompt();throw Error('Unexpected wallet request');}}}};
   window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(wallet));
   window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:({register})=>register(wallet)}));
 });
 const page=await ctx.newPage();await page.goto(config.origin);
 await page.locator('dialog.public-mint-dialog').waitFor({state:'attached'});
 await page.locator('.bear-lang[data-lang="'+lang+'"]').click();
 await page.locator('#plus').click();assert.equal(await page.locator('#qty').inputValue(),'2');
 await page.locator('#mintBtn').click();
 const msg=page.locator('[data-view=message]');
 try{await page.waitForFunction(()=>document.querySelector('[data-view=message]')?.textContent.includes('00:00'),{},{timeout:9000});}
 catch(e){console.log('observed',await msg.textContent(), '#minted',await page.locator('#minted').textContent(),prepares,forbidden);throw e;}
 assert.match(await msg.textContent(),{ru:/лимит проверок покупки исчерпан/,en:/limit has been reached/,zh:/已达上限/}[lang]);
 await page.waitForTimeout(700);assert.deepEqual([prepares,calls,forbidden.length],[1,0,0]);
 console.log(engine,lang,'selected 2, one local preparation, reset time displayed, zero wallet prompts or submissions');
 await ctx.close();
}}finally{await browser.close();}
