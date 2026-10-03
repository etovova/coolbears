// Actual private UI in Chromium; dependency ports and wallet discovery are fixtures.
// No real signing, gateway, RPC, wallets, physical phones, funds or deployment.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const playwright=await import(process.env.COOLBEARS_PLAYWRIGHT||'playwright');
const parent=await mkdtemp(path.join(tmpdir(),'coolbears-private-console-')),output=path.resolve('operator/build/buyer-console-chromium');await mkdir(output,{recursive:true});
const bundle=path.join(parent,'app.js'),source='operator/orders/buyer-console';
await build({stdin:{contents:`import {buyerConsoleFixture} from './operator/tests/fixtures/buyer-console.mjs';
import {mountPrivateBuyerConsole} from './operator/orders/buyer-console/view.mjs';
const f=buyerConsoleFixture();const retained=JSON.parse(sessionStorage.getItem('ui-fixture')||'null');
if(retained){f.saved.push(...retained.saved);for(const [k,v]of retained.records)f.records.set(k,v);Object.assign(f.calls,retained.calls);}
const incompatible={...f.wallet,name:'Unsupported send-only wallet',features:{...f.wallet.features,'solana:signTransaction':undefined,'solana:signAndSendTransaction':{signAndSendTransaction(){throw Error('forbidden')}}}};
const registry={get:()=>[incompatible,f.wallet],on:()=>()=>{}};
window.fixture=f;window.ui=mountPrivateBuyerConsole({controller:f.controller,registry});
window.keepFixture=()=>sessionStorage.setItem('ui-fixture',JSON.stringify({saved:f.saved,records:[...f.records],calls:f.calls}));`,resolveDir:process.cwd(),sourcefile:'private-console-fixture.mjs'},
  bundle:true,platform:'browser',format:'esm',target:'es2022',outfile:bundle,inject:['scripts/browser-buffer.mjs']});
await promisify(execFile)(process.execPath,[source+'/build.mjs','--out',path.join(parent,'blocked')]);
const report={passed:false,engine:'chromium',adapters:'simulated UI dependency ports',realWallets:false,physicalPhones:false,liveRpc:false,transactionsSent:0,externalRequests:0,pageErrors:[],cases:[],screenshots:[]};
const server=createServer(async(req,res)=>{try{
  let file;if(req.url==='/app.js')file=bundle;else if(req.url==='/style.css')file=path.join(source,'style.css');
  else if(req.url==='/')file=path.join(source,'index.html');else if(['/blocked/index.html','/blocked/app.js','/blocked/style.css'].includes(req.url))file=path.join(parent,req.url.slice(1));
  if(!file){res.writeHead(404);res.end();return;}const bytes=await readFile(file);res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','cache-control':'no-store'});res.end(bytes);
}catch{res.writeHead(500);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser,context,page;
const button=id=>page.locator('#'+id);
const ready=()=>page.waitForFunction(()=>window.fixture&&!fixture.controller.state().busy);
const snap=async(name)=>{const filename=name+'.png';await page.screenshot({path:path.join(output,filename),fullPage:true});report.screenshots.push(filename);};
try{
  browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});context=await browser.newContext({viewport:{width:1280,height:1000}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests++;return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(origin);await ready();
  assert.equal(await button('wallets').locator('option').count(),2);assert.equal(await button('send').isDisabled(),true);
  assert.ok(Object.values(await page.evaluate(()=>fixture.calls)).every(n=>n===0));
  report.cases.push('initial rendered UI excludes send-only wallets and performs no persistence, preparation, signing, send or recovery automatically');
  await button('storage-consent').check();await button('persist').click();await ready();
  await button('wallets').selectOption('0');await button('connect').click();await ready();
  const address=await page.evaluate(()=>fixture.account.address);await button('accounts').selectOption(address);await button('choose-account').click();await ready();
  await button('quantity').fill('2');await button('create').click();await ready();assert.match(await button('progress').textContent(),/0 of 2/);
  await button('prepare').click();await ready();await button('quote').click();await ready();
  assert.match(await button('costs').textContent(),/0\.203509999 SOL/);assert.match(await button('costs').textContent(),/0\.001999999 SOL/);
  assert.match(await button('costs').textContent(),/0\.0015 SOL/);assert.equal(await button('sign').isDisabled(),true);
  await snap('desktop-cost-review');await page.setViewportSize({width:390,height:844});await snap('mobile-cost-review');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1280,height:1000});
  report.cases.push('explicit persistence, exact account, quantity and preparation render separate price, fee, funding and protocol components without approving the wallet');
  await button('cost-cap').fill('0.1');await button('cost-consent').check();await button('sign').click();await ready();assert.equal(await page.evaluate(()=>fixture.calls.wallet),0);
  assert.match(await button('error').textContent(),/cost approval/);
  await page.evaluate(()=>{fixture.advanceTime(300001);ui.render();});assert.equal(await button('sign').isDisabled(),true);assert.equal(await button('cost-consent').isChecked(),false);
  await button('quote').click();await ready();await button('cost-consent').check();await button('sign').click();await ready();
  assert.equal(await page.evaluate(()=>fixture.calls.wallet),1);assert.equal(await page.evaluate(()=>fixture.calls.send),0);assert.equal(await button('send').isDisabled(),true);
  assert.match(await button('items').textContent(),/Outcome unknown/);assert.equal(await button('prepare').isDisabled(),true);
  report.cases.push('too-low cap and expired quote produce no wallet call; a fresh separate consent signs once, leaves the outcome unknown and never sends');
  await page.evaluate(()=>keepFixture());const before=await page.evaluate(()=>structuredClone(fixture.calls));await page.reload();await ready();
  assert.deepEqual(await page.evaluate(()=>fixture.calls),before);const id=await page.evaluate(()=>fixture.saved[0].id);
  await button('orders').selectOption(id);await button('resume-order').click();await ready();
  assert.match(await button('items').textContent(),/Outcome unknown/);assert.equal(await button('sign').isDisabled(),true);
  await button('recover').click();await ready();assert.equal(await page.evaluate(()=>fixture.calls.recover),before.recover+1);
  report.cases.push('a reloaded scope resumes the retained unknown state without wallet approval or duplicate creation and checks outcome only on an explicit click');
  await page.evaluate(async()=>{fixture.failAttempt();await fixture.controller.refresh();ui.render();});
  assert.match(await button('failed-fee').textContent(),/0\.00001 SOL/);await button('replacement-consent').check();assert.equal(await button('replace').isDisabled(),true);
  await button('fee-consent').check();await button('replace').click();await ready();assert.equal(await page.evaluate(()=>fixture.calls.replacementSign),0);
  assert.match(await button('replacement-review').textContent(),/attempt 2/);assert.equal(await button('replacement-sign').isDisabled(),true);await snap('desktop-replacement-review');
  await button('replacement-signing-consent').check();await button('replacement-sign').click();await ready();assert.equal(await page.evaluate(()=>fixture.calls.replacementSign),1);
  assert.equal(await button('sign').isDisabled(),true);assert.equal(await page.evaluate(()=>fixture.calls.wallet),1);
  report.cases.push('actual failed fee acknowledgment permits replacement review only; a separate reviewed preparation consent creates the replacement and still grants no wallet approval or send');
  await page.evaluate(async()=>{fixture.snapshot.custody.status='unavailable';await fixture.controller.refresh();ui.render();});
  assert.equal(await button('custody').isVisible(),true);for(const id of ['prepare','quote','sign','expiry','replace','replacement-sign'])assert.equal(await button(id).isDisabled(),true,id);
  await button('recover').click();await ready();assert.equal(await page.evaluate(()=>fixture.calls.readonly),1);assert.match(await button('outcome').textContent(),/Read-only outcome/);
  await page.setViewportSize({width:390,height:844});await snap('mobile-custody-loss');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  report.cases.push('missing custody leaves only retained-outcome review available; mobile UI labels it read-only and exposes no signing or replacement permission');
  const blocked=await context.newPage();blocked.on('pageerror',e=>report.pageErrors.push(e.message));await blocked.goto(origin+'/blocked/index.html');
  await blocked.waitForFunction(()=>document.getElementById('configuration').textContent.includes('not configured'));
  assert.equal(await blocked.locator('#workspace').isVisible(),false);await blocked.close();
  report.cases.push('the default production bundle has no private configuration and keeps all wallet, storage and network controls blocked');
  assert.equal(await page.evaluate(()=>fixture.calls.send),0);assert.deepEqual(report.pageErrors,[]);assert.equal(report.externalRequests,0);report.passed=true;
}finally{
  report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  await context?.close();await browser?.close();await new Promise(r=>server.close(r));await rm(parent,{recursive:true,force:true});
}
