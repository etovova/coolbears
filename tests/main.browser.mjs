// Main-site browser acceptance. Wallets are simulated; no RPC or real signing.
// Chromium device emulation is not a physical iPhone, Android or Safari test.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import publicDeployment from '../public-mainnet/deployment.mjs';

const playwright = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const { devices } = playwright;
const engine = process.env.COOLBEARS_ENGINE || 'chromium';
const output = process.env.COOLBEARS_MAIN_BROWSER_OUTPUT || 'build/main-browser-check';
const source = path.resolve(process.env.COOLBEARS_MAIN_SITE_ROOT || '.');
const origin = 'https://coolbears-nfts.com'; // All requests are intercepted locally.
const owner = 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
const other = 'BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF';
const report = { checkedAt: new Date().toISOString(), engine, physicalDevices: false, realWallets: false, realTransactionsSent: 0, source: process.env.COOLBEARS_MAIN_SITE_ROOT ? 'staged site' : 'repository source', cases: [], pageErrors: [] };
const contents = new Map();
let unexpectedWrites = 0;
await mkdir(output, { recursive: true });
const browser = await playwright[engine].launch({ executablePath: process.env.COOLBEARS_CHROMIUM || undefined, headless: true, args: engine === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'] : [] });

async function open({ device = 'Desktop Chrome', storage = 'normal', wallet = false, stallPublicModule = false, readiness = null } = {}) {
  const { defaultBrowserType: _engine, ...descriptor } = devices[device];
  if (engine === 'firefox') delete descriptor.isMobile;
  const context = await browser.newContext(descriptor);
  const page = await context.newPage();
  const errors = [];
  let readinessCalls=0;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.method() !== 'GET') { unexpectedWrites++; return route.abort(); }
    const url = new URL(request.url());
    if (stallPublicModule && url.pathname === '/public-mainnet/site-entry.mjs') return; // Explicit stalled-download fixture.
    if(url.pathname==='/api/buyer/readiness'&&readiness!==null){
      readinessCalls++;
      // The synthetic HTTPS response uses the actual pinned public deployment;
      // no UI option, legacy wallet adapter or query string can enable minting.
      const checkedAt=await page.evaluate(()=>Date.now());
      const response={version:1,status:readiness==='closed'?'closed':'open',cluster:publicDeployment.cluster,genesisHash:publicDeployment.genesisHash,machine:publicDeployment.machine,collection:publicDeployment.collection,guard:publicDeployment.guard,storageMode:publicDeployment.storageMode,hiddenCommitmentSha256:publicDeployment.hiddenCommitmentSha256,unitPriceLamports:'200000000',maximumPerOrder:50,profileSha256:readiness==='wrong-profile'?'0'.repeat(64):publicDeployment.profileSha256,checkedAt,expiresAt:checkedAt+10000,salesOpen:readiness!=='closed'};
      return route.fulfill({contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(response)});
    }
    if (url.origin !== origin) return route.abort();
    let name = url.pathname;
    if (name.endsWith('/')) name += 'index.html';
    const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[path.extname(name)] || 'text/html';
    try {
      if (!contents.has(name)) contents.set(name, await readFile(path.join(source, name)));
      return route.fulfill({ contentType: type, body: contents.get(name) });
    } catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await page.addInitScript(({ storage, wallet, owner }) => {
    if (storage === 'denied') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
    if (storage === 'full') Storage.prototype.setItem = function () { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); };
    if (!wallet) return;
    const listeners = new Map();
    const state = window.__testWallet = { connects: 0, disconnects: 0, signatures: 0, mode: 'ready' };
    const publicBytes = address => { const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of address)n=n*58n+BigInt(alphabet.indexOf(c));const bytes=new Uint8Array(32);for(let i=31;i>=0;i--){bytes[i]=Number(n&255n);n>>=8n;}return bytes; };
    const account = address => ({address,publicKey:publicBytes(address),chains:['solana:mainnet'],features:['solana:signTransaction']});
    let available=owner;
    const provider = {
      version:'1.0.0',name:'Phantom',icon:'data:image/svg+xml;base64,PHN2Zy8+',chains:['solana:mainnet'],accounts:[],
      features:{
        'standard:connect':{version:'1.0.0',async connect(){state.connects++;if(state.mode==='reject')throw Object.assign(Error('Connection cancelled'),{code:4001});if(state.mode==='delayed')await new Promise(resolve=>{state.resolve=resolve;});provider.accounts=available?[account(available)]:[];return{accounts:provider.accounts};}},
        'standard:disconnect':{version:'1.0.0',async disconnect(){state.disconnects++;provider.emit('disconnect');}},
        'standard:events':{version:'1.0.0',on(name,handler){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(handler);return()=>listeners.get(name)?.delete(handler);}},
        'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:[0],async signTransaction(){state.signatures++;throw Error('Signing must remain unavailable');}},
      },
      emit(name,address){if(name==='accountChanged')available=address;if(name==='disconnect')provider.accounts=[];else provider.accounts=available?[account(available)]:[];for(const handler of [...(listeners.get('change')||[])])handler({accounts:provider.accounts});},
      setAccount(address){available=address;provider.accounts=[];},
    };
    state.provider=provider;
    window.addEventListener('wallet-standard:app-ready',event=>event.detail.register(provider));

  }, { storage, wallet, owner });
  await page.goto(origin + '/', { waitUntil: stallPublicModule ? 'domcontentloaded' : 'networkidle' });
  return { page, context, readinessCalls:()=>readinessCalls, async done(name, details = {}) {
    assert.deepEqual(errors, [], `${name}: uncaught browser errors`);
    report.cases.push({ name, device, storage, readinessCalls, ...details });
    await context.close();
  } };
}
async function closed(page) {
  assert.equal(await page.locator('#mintBtn').isDisabled(), true, 'public mint remains closed');
  assert.equal(await page.locator('#marketplaceTop').isVisible(), false, 'unverified market link remains hidden');
}
async function modal(page) {
  await page.locator('#walletBtn').click();
  await page.locator('.public-mint-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.public-mint-dialog').count(), 1);
}
async function noOverflow(page) {
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, JSON.stringify(widths));
}

try {
  for (const device of ['iPhone SE', 'iPhone 13', 'Pixel 7', 'iPad Pro 11', 'Desktop Chrome']) {
    const test = await open({ device });
    const { page } = test;
    for (const lang of ['en', 'ru', 'zh']) {
      await page.locator(`.bear-lang[data-lang="${lang}"]`).click();
      assert.equal(await page.locator('html').getAttribute('lang'), lang === 'zh' ? 'zh-CN' : lang);
      await page.locator('#qty').fill('1');
      assert.equal(await page.locator('#qty').inputValue(), '1');
      await page.locator('#minus').click();
      assert.equal(await page.locator('#qty').inputValue(), '1');
      await page.locator('#qty').fill('50');
      assert.equal(await page.locator('#total').textContent(), '10');
      await page.locator('#plus').click();
      assert.equal(await page.locator('#qty').inputValue(), '50');
      await page.locator('#qty').fill('999');
      assert.equal(await page.locator('#qty').inputValue(), '50');
      await page.locator('#qty').fill('-2');
      assert.equal(await page.locator('#qty').inputValue(), '1');
      await noOverflow(page);
      await closed(page);
    }
    await page.locator('.bear-lang[data-lang="ru"]').click();
    await modal(page);
    const dialog = page.locator('.public-mint-dialog');
    const bounds = await dialog.boundingBox();
    const width = await page.evaluate(() => innerWidth);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'wallet picker fits viewport');
    const links = await dialog.locator('a').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, href: node.href })));
    const mobile = !device.startsWith('Desktop');
    const phantom = links.find(link => link.text.includes('Phantom'));
    const solflare = links.find(link => link.text.includes('Solflare'));
    const backpack = links.find(link => link.text.includes('Backpack'));
    assert.ok(phantom && solflare && backpack);
    if (mobile) {
      assert.equal(new URL(phantom.href).hostname, 'phantom.app');
      assert.ok(decodeURIComponent(phantom.href).includes(origin));
      assert.equal(new URL(solflare.href).hostname, 'solflare.com');
      assert.ok(backpack.href.startsWith('https://backpack.app/ul/v1/browse/'));
    } else assert.equal(new URL(phantom.href).hostname, 'phantom.com');
    await page.screenshot({ path: path.join(output, `${device.toLowerCase().replaceAll(' ', '-')}-wallet.png`), fullPage: false });
    await dialog.locator('[data-action="close"]').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.evaluate(node=>node.open),false);
    await page.locator('#walletBtn').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#walletBtn').hasAttribute('aria-busy'));
    if (device === 'Desktop Chrome') {
      await modal(page);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.public-mint-dialog').open);
    }
    // Exercise lazy loading by visiting the artwork, as a scrolling visitor does.
    for (const image of await page.locator('img').all()) {
      await image.scrollIntoViewIfNeeded();
      // Lazy loading starts asynchronously after the scroll. Firefox/WebKit
      // can reject decode() while that initial image request is still changing.
      await page.waitForFunction(node => node.complete && node.naturalWidth > 0, await image.elementHandle(), { timeout: 15000 });
      await image.evaluate(node => node.decode());
    }
    assert.equal(await page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(output, `${device.toLowerCase().replaceAll(' ', '-')}-page.png`), fullPage: true });
    await test.done('three languages, quantity boundaries, closed mint and wallet links', { languages: ['en', 'ru', 'zh'], mobileUserAgent: mobile, touchEmulation: mobile });
  }

  for (const storage of ['denied', 'full']) {
    const test = await open({ device: 'Pixel 7', storage });
    const { page } = test;
    await page.locator('.bear-lang[data-lang="ru"]').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    await page.locator('#plus').click();
    assert.equal(await page.locator('#qty').inputValue(), '2');
    await modal(page);
    await page.locator('[data-action="close"]').click();
    await closed(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await test.done('storage unavailable preserves calculator, language and wallet picker');
  }

  for (const device of ['Desktop Chrome', 'Pixel 7']) {
    const test = await open({ device, wallet: true });
    const { page } = test;
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(address => document.querySelector('#walletBtn').title === address, owner);
    await closed(page);
    await page.evaluate(address => window.__testWallet.provider.emit('accountChanged', address), other);
    await page.waitForFunction(() => document.querySelector('#walletBtn').title === '');
    await closed(page);
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(address => document.querySelector('#walletBtn').title === address, other);
    await page.locator('#walletBtn').click();
    await page.waitForFunction(() => document.querySelector('#walletBtn').title === '');
    assert.equal(await page.evaluate(() => window.__testWallet.disconnects), 1);
    await page.evaluate(address => { window.__testWallet.provider.setAccount(address); }, owner);
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(address => document.querySelector('#walletBtn').title === address, owner);
    await page.evaluate(() => window.__testWallet.provider.emit('disconnect'));
    await page.waitForFunction(() => document.querySelector('#walletBtn').title === '');
    assert.equal(await page.evaluate(() => window.__testWallet.signatures), 0);
    await test.done('connect, account change, explicit disconnect, reconnect and provider disconnect');
  }

  {
    const test = await open({ wallet: true });
    const { page } = test;
    await page.evaluate(() => { window.__testWallet.mode = 'reject'; });
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(() => document.querySelector('.public-mint-dialog [data-view="message"]').textContent.includes('could not finish'));
    await page.locator('.public-mint-dialog [data-action="close"]').click();
    assert.equal(await page.locator('#walletBtn').getAttribute('title'), '');
    await page.evaluate(() => { window.__testWallet.mode = 'delayed'; });
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(() => typeof window.__testWallet.resolve === 'function');
    await page.locator('#walletBtn').dblclick();
    assert.equal(await page.evaluate(() => window.__testWallet.connects), 2, 'pending connection prevents duplicate wallet calls');
    assert.equal(await page.locator('.public-mint-dialog').count(), 1);
    await page.evaluate(() => window.__testWallet.resolve());
    await page.waitForFunction(address => document.querySelector('#walletBtn').title === address, owner);
    await closed(page);
    await test.done('cancelled connection is retryable and repeated clicks cannot duplicate a pending connection');
  }
  {
    const test = await open({ wallet: true });
    const { page } = test;
    await page.clock.install();
    await page.evaluate(() => { window.__testWallet.mode = 'delayed'; });
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(() => typeof window.__testWallet.resolve === 'function');
    await page.clock.fastForward(60001);
    await page.waitForFunction(() => !document.querySelector('#walletBtn').hasAttribute('aria-busy'));
    assert.equal(await page.locator('#walletBtn').getAttribute('title'), '');
    await page.evaluate(() => { window.__testWallet.resolve(); window.__testWallet.mode = 'ready'; });
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.locator('#walletBtn').getAttribute('title'), '', 'late reply after timeout cannot connect silently');
    await modal(page);
    await page.locator('.public-mint-dialog button', { hasText: /^Phantom$/ }).click();
    await page.waitForFunction(address => document.querySelector('#walletBtn').title === address, owner);
    await closed(page);
    await test.done('unresponsive wallet releases UI after deadline; late reply is ignored and reconnect works', { clockAdvanced: true });
  }
  {
    const test = await open({stallPublicModule:true});
    const {page}=test;await page.clock.install();
    await page.locator('#walletBtn').click();
    await page.waitForFunction(()=>document.querySelector('#walletBtn').hasAttribute('aria-busy'));
    await page.clock.fastForward(15001);
    await page.waitForFunction(()=>!document.querySelector('#walletBtn').hasAttribute('aria-busy'));
    await closed(page);
    await test.done('stalled public-module download releases loading state',{clockAdvanced:true});
  }
  for(const readiness of ['open','closed','wrong-profile']){
    const test=await open({readiness});const {page}=test;
    await page.clock.install();assert.equal(test.readinessCalls(),0,'passive homepage makes no readiness RPC');
    await page.getByRole('button',{name:'Check mint availability',exact:true}).first().click();
    await page.waitForFunction(()=>!document.querySelector('.public-mint-dialog [data-view="message"]').textContent.includes('Waiting'));
    assert.equal(test.readinessCalls(),1);
    assert.equal(await page.locator('#mintBtn').isDisabled(),readiness!=='open');
    if(readiness==='open'){
      assert.equal(await page.locator('#minted').textContent(),'MINT IS OPEN');
      await page.clock.fastForward(10001);
      assert.equal(await page.locator('#mintBtn').isDisabled(),true,'expired proof closes mint without a timer fetch');
      assert.equal(test.readinessCalls(),1);
    }
    await test.done('strict public readiness '+readiness+' and no passive polling',{syntheticReadiness:true});
  }
  assert.equal(unexpectedWrites, 0);
  report.networkWrites = unexpectedWrites;
  await writeFile(path.join(output, 'main-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
