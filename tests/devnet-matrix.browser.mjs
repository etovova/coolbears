// Deterministic browser integration. Wallets and RPC are fixtures: no external
// requests, private keys, real wallet approvals, or blockchain submissions.
// This does not emulate the internals of mobile wallet apps or Safari/Firefox.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { settings as S } from '../devnet/settings.mjs';

const playwright = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const engine = process.env.COOLBEARS_ENGINE || 'chromium';
const output = process.env.COOLBEARS_BROWSER_OUTPUT || 'build/browser-matrix';
await mkdir(output, { recursive: true });
const fixture = JSON.parse(await readFile('tests/fixtures/devnet-rpc.json', 'utf8'));
const assetFixture = JSON.parse(await readFile('tests/fixtures/devnet-existing-asset.json', 'utf8'));
const signature = '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7';
const origin = 'https://coolbears-nfts.com';
const customRpc = 'https://custom-rpc.example/devnet?api-key=matrix-public-fixture-key';
const mobileUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const browser = await playwright[engine].launch({
  executablePath: process.env.COOLBEARS_CHROMIUM || undefined,
  headless: true, args: engine === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'] : [],
});
const cases = [];
let totalRpcWrites = 0;
let complete = false;

async function makeHarness(options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 390, height: 844 },
    ...(engine === 'firefox' ? {} : { isMobile: options.mobile ?? false }), hasTouch: options.mobile ?? false,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const h = { context, page, mode: options.mode || 'ready', requests: [], links: [], errors: [], walletCalls: 0, retryCount: 0, customMode: 'ready' };
  page.on('pageerror', error => h.errors.push(error.message));
  await page.exposeFunction('matrixWalletCall', () => { h.walletCalls++; });
  await page.exposeFunction('matrixRpcMode', mode => { h.mode = mode; });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      let name = url.pathname;
      if (name.endsWith('/')) name += 'index.html';
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.gif') ? 'image/gif' : 'text/html';
      try { return route.fulfill({ contentType: type, body: await readFile(path.join('public-site', name)) }); }
      catch { return route.fulfill({ status: 404, body: 'Fixture file not found' }); }
    }
    if (['phantom.app', 'solflare.com', 'backpack.app'].includes(url.hostname)) {
      h.links.push(request.url());
      return route.fulfill({ contentType: 'text/html', body: '<title>Wallet app link fixture</title>' });
    }
    if (request.url() !== new URL(S.rpc).href && url.hostname !== 'custom-rpc.example') {
      h.errors.push(`Unexpected external request to ${url.origin}`);
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': '*' } });
    const rpc = request.postDataJSON();
    h.requests.push({ method: rpc.method, custom: url.hostname === 'custom-rpc.example' });
    if (rpc.method === 'sendTransaction') totalRpcWrites++;
    const mode = url.hostname === 'custom-rpc.example' ? h.customMode : h.mode;
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === '429' || (mode === '429-once' && h.retryCount++ === 0)) {
      return route.fulfill({ status: 429, headers: { 'retry-after': '0', 'access-control-allow-origin': origin }, body: '{}' });
    }
    let result = structuredClone(fixture[rpc.method]);
    if (rpc.method === 'getGenesisHash' && mode === 'wrong-genesis') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    if (rpc.method === 'getBalance' && mode === 'insufficient') result.value = 100;
    if (rpc.method === 'simulateTransaction') result = { context: { slot: 502145500 }, value: { err: mode === 'simulation-error' ? { InstructionError: [1, { Custom: 6033 }] } : null, logs: [], unitsConsumed: 57949 } };
    if (rpc.method === 'getSignaturesForAddress') result = mode === 'finalized' ? [{ signature, err: null }] : [];
    if (rpc.method === 'getSignatureStatuses') result = { context: { slot: 502145500 }, value: [mode === 'finalized' ? { slot: 502145500, confirmationStatus: 'finalized', err: null } : null] };
    if (rpc.method === 'getAccountInfo') result = mode === 'finalized' ? assetFixture : { context: { slot: 502145500 }, value: null };
    if (rpc.method === 'isBlockhashValid') result = { context: { slot: 502145500 }, value: true };
    if (rpc.method === 'getBlockHeight') result = fixture.getLatestBlockhash.value.lastValidBlockHeight - 5;
    assert.notEqual(result, undefined, `Missing RPC fixture: ${rpc.method}`);
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) });
  });
  await page.addInitScript(({ owner, key, sig, signatureBytes, ownerBytes, providerName, storage, ownerOverride, shortWalletDeadline }) => {
    if (shortWalletDeadline) {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 60000 ? 150 : delay, ...args);
    }
    window.matrix = { walletCalls: 0, connectCalls: 0, walletMode: 'reject', journalVerified: false, options: null, change: null };
    if (storage === 'corrupt') localStorage.setItem(key, '{invalid-json');
    if (storage === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked fixture storage', 'SecurityError'); } });
    if (storage === 'quota') Storage.prototype.setItem = () => { throw new DOMException('Full fixture storage', 'QuotaExceededError'); };
    const listeners = {};
    const publicKey = { toString: () => ownerOverride || owner };
    const provider = {
      isPhantom: providerName === 'Phantom', isSolflare: providerName === 'Solflare', publicKey,
      async connect() { window.matrix.connectCalls++; return { publicKey: this.publicKey }; },
      on(name, handler) { listeners[name] = handler; }, removeListener(name) { delete listeners[name]; },
      async signAndSendTransaction(transaction, options) {
        window.matrix.walletCalls++; await window.matrixWalletCall();
        const saved = JSON.parse(localStorage.getItem(key));
        if (!saved?.asset || saved.stage !== 'wallet-pending') throw Error('Journal not persisted before wallet prompt');
        if (transaction.version !== 0 || !transaction.signatures.some(bytes => bytes.some(byte => byte !== 0)) || options.skipPreflight !== false) throw Error('Invalid partial transaction');
        window.matrix.journalVerified = true;
        window.matrix.options = options;
        if (window.matrix.walletMode === 'hold') return new Promise((resolve, reject) => { window.matrix.rejectWallet = () => reject(Object.assign(Error('Rejected'), { code: 4001 })); window.matrix.resolveWallet = () => resolve({ signature: sig }); });
        if (window.matrix.walletMode === 'reject') throw Object.assign(Error('Rejected'), { code: 4001 });
        if (window.matrix.walletMode === 'unknown') { await window.matrixRpcMode('offline'); throw Error('Wallet disconnected'); }
        return { signature: sig };
      },
    };
    window.matrix.change = () => { provider.publicKey = { toString: () => '11111111111111111111111111111111' }; listeners.accountChanged?.(provider.publicKey); };
    if (providerName === 'Phantom') window.phantom = { solana: provider };
    if (providerName === 'Solflare') window.solflare = provider;
    window.matrix.register = (name = 'Backpack', chain = 'solana:devnet', versions = [0]) => {
      const account = { address: owner, publicKey: new Uint8Array(ownerBytes), chains: [chain], features: ['solana:signAndSendTransaction'] };
      const wallet = {
        version: '1.0.0', name, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: [chain], accounts: [account],
        features: {
          'standard:connect': { version: '1.0.0', async connect() { window.matrix.connectCalls++; return { accounts: wallet.accounts }; } },
          'standard:events': { version: '1.0.0', on(event, listener) { window.matrix.standardChange = listener; return () => { window.matrix.standardChange = null; }; } },
          'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: versions, async signAndSendTransaction(input) {
            await window.matrixWalletCall(); window.matrix.walletCalls++;
            const saved = JSON.parse(localStorage.getItem(key));
            if (!saved?.asset || saved.stage !== 'wallet-pending') throw Error('Standard wallet missing journal');
            if (input.chain !== 'solana:devnet' || input.account.address !== owner || !(input.transaction instanceof Uint8Array) || input.options.skipPreflight !== false) throw Error('Invalid Wallet Standard request');
            window.matrix.standardRequestVerified = true;
            if (window.matrix.walletMode === 'reject') throw Object.assign(Error('Rejected'), { code: 4001 });
            return [{ signature: new Uint8Array(signatureBytes) }];
          } },
        },
      };
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet) }));
      return wallet;
    };
  }, { owner: S.owner, key: S.storageKey, sig: signature, signatureBytes: Array.from(base58.serialize(signature)), ownerBytes: Array.from(base58.serialize(S.owner)), providerName: options.provider === undefined ? 'Phantom' : options.provider, storage: options.storage, ownerOverride: options.owner, shortWalletDeadline: options.shortWalletDeadline });
  await page.goto(`${origin}/devnet/`, { waitUntil: 'networkidle' });
  h.status = async pattern => page.waitForFunction(source => new RegExp(source).test(document.querySelector('#status').textContent), pattern.source, { timeout: 15000 });
  h.connect = async (id = 'phantom') => { await page.locator(`#${id}`).click(); await page.waitForFunction(() => !document.querySelector('#mint').disabled); };
  return h;
}

async function scenario(name, options, body) {
  const started = Date.now();
  const h = await makeHarness(options);
  try {
    await body(h);
    assert.deepEqual(h.errors, [], `${name}: unexpected page errors or external requests`);
    assert.equal(totalRpcWrites, 0, 'Application must not submit RPC transactions');
    cases.push({ name, passed: true, durationMs: Date.now() - started, mockedWalletCalls: h.walletCalls, rpcReadAndSimulationRequests: h.requests.length });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, passed: false, error: error.message, status: await h.page.locator('#status').textContent().catch(() => null), pageErrors: h.errors });
    await h.page.screenshot({ path: path.join(output, `failure-${cases.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await h.context.close(); }
}

try {
  for (const profile of [
    { name: 'phone-320', width: 320, height: 740, mobile: true, userAgent: mobileUA },
    { name: 'phone-390', width: 390, height: 844, mobile: true, userAgent: iphoneUA },
    { name: 'tablet-768', width: 768, height: 1024, mobile: true, userAgent: ipadUA },
    { name: 'desktop-1440', width: 1440, height: 960, mobile: false },
  ]) await scenario(`layout and connection: ${profile.name}`, { viewport: { width: profile.width, height: profile.height }, mobile: profile.mobile, userAgent: profile.userAgent }, async h => {
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.requests.length, 0, 'Reload must not automatically contact RPC or a wallet');
    await h.connect();
    assert.equal(await h.page.locator('#wallet').textContent(), S.owner);
    assert.match(await h.page.locator('#phantom').textContent(), /подключ[её]н/i);
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Horizontal overflow');
    assert.equal(await h.page.locator('#mint').evaluate(node => node.getBoundingClientRect().height >= 44), true, 'Mint tap target too small');
    await h.page.screenshot({ path: path.join(output, `${profile.name}.png`), fullPage: true });
    assert.equal(h.walletCalls, 0);
  });

  await scenario('429 recovers after a bounded retry', { mode: '429-once' }, async h => {
    await h.connect();
    assert.equal(h.requests.filter(item => item.method === 'getGenesisHash').length, 2);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('persistent 429 blocks mint without repeated unbounded calls', { mode: '429' }, async h => {
    await h.page.locator('#phantom').click(); await h.status(/429/);
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.requests.length, 3);
    assert.equal(h.walletCalls, 0);
    assert.equal(await h.page.locator('#wallet').textContent(), S.owner);
  });
  await scenario('a fresh 429 invalidates earlier ready state', {}, async h => {
    await h.connect(); h.mode = '429'; await h.page.locator('#check').click(); await h.status(/429/);
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('offline failure remains recoverable without a wallet prompt', { mode: 'offline' }, async h => {
    await h.page.locator('#phantom').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.walletCalls, 0);
    h.mode = 'ready'; await h.page.locator('#check').click();
    await h.page.waitForFunction(() => !document.querySelector('#mint').disabled);
  });
  await scenario('wrong genesis blocks a Mainnet endpoint before transaction preparation', { mode: 'wrong-genesis' }, async h => {
    await h.page.locator('#phantom').click(); await h.status(/Требуется Solana Devnet/);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.deepEqual(h.requests.map(item => item.method), ['getGenesisHash']);
    assert.equal(h.walletCalls, 0);
  });
  for (const [mode, pattern] of [['insufficient', /Недостаточно тестового SOL/], ['simulation-error', /Симуляция минта/]]) {
    await scenario(`${mode} stops before signing`, {}, async h => {
      await h.connect(); h.mode = mode; await h.page.locator('#mint').click(); await h.status(pattern);
      assert.equal(h.walletCalls, 0);
      assert.equal(await h.page.evaluate(key => localStorage.getItem(key), S.storageKey), null);
    });
  }
  await scenario('wrong owner cannot open a signing request', { owner: S.laboratory }, async h => {
    await h.page.locator('#phantom').click(); await h.status(/FNyt/);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.requests.length, 0); assert.equal(h.walletCalls, 0);
  });
  await scenario('wallet rejection preserves a durable journal and allows a later attempt', {}, async h => {
    await h.connect(); await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    assert.equal(h.walletCalls, 1);
    assert.equal(await h.page.evaluate(() => window.matrix.journalVerified), true);
    assert.equal(await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)).stage, S.storageKey), 'cancelled');
    assert.equal(await h.page.locator('#mint').isDisabled(), false);
  });
  await scenario('double click produces one wallet request', {}, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'hold'; document.querySelector('#mint').click(); document.querySelector('#mint').click(); });
    await h.page.waitForFunction(() => typeof window.matrix.rejectWallet === 'function');
    assert.equal(h.walletCalls, 1);
    await h.page.evaluate(() => window.matrix.rejectWallet()); await h.status(/Подпись отменена/);
  });
  await scenario('account change disables mint until a fresh connection', {}, async h => {
    await h.connect(); await h.page.evaluate(() => window.matrix.change()); await h.status(/Аккаунт кошелька изменился/);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.match(await h.page.locator('#wallet').textContent(), /не подключ[её]н/);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('unknown result survives reload and recovers finalized without resending', {}, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'unknown'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const pending = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(pending.stage, 'unknown'); assert.equal(h.walletCalls, 1);
    h.mode = 'ready'; const before = h.requests.length;
    await h.page.reload({ waitUntil: 'networkidle' });
    assert.equal(h.requests.length, before, 'Reload should never auto-poll an unknown operation');
    assert.equal(await h.page.locator('#mint').isDisabled(), true); assert.equal(h.walletCalls, 1);
    h.mode = 'finalized'; await h.page.locator('#check').click(); await h.status(/NFT выпущен и проверен/);
    const recovered = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(recovered.asset, pending.asset); assert.equal(recovered.signature, signature); assert.equal(recovered.stage, 'verified');
    assert.equal(await h.page.locator('#mint').isDisabled(), true); assert.equal(h.walletCalls, 1);
  });
  await scenario('late wallet signature after an accelerated timeout remains recoverable', { shortWalletDeadline: true }, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'hold'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => typeof window.matrix.resolveWallet === 'function');
    h.mode = 'offline';
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const unknown = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(unknown.stage, 'unknown'); assert.equal(unknown.signature, null);
    await h.page.evaluate(() => window.matrix.resolveWallet());
    await h.page.waitForFunction(({ key, signature }) => JSON.parse(localStorage.getItem(key)).signature === signature, { key: S.storageKey, signature });
    h.mode = 'finalized'; await h.page.locator('#check').click(); await h.status(/NFT выпущен и проверен/);
    const recovered = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(recovered.asset, unknown.asset); assert.equal(recovered.signature, signature); assert.equal(recovered.stage, 'verified');
    assert.equal(h.walletCalls, 1);
  });
  for (const storage of ['corrupt', 'blocked']) await scenario(`${storage} storage blocks signing`, { storage }, async h => {
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(await h.page.locator('#check').isDisabled(), true);
    assert.match(await h.page.locator('#status').textContent(), /операци|журнал|сохран/i);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('storage quota failure blocks wallet prompt', { storage: 'quota' }, async h => {
    await h.connect(); await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(h.walletCalls, 0);
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), S.storageKey), null);
  });
  await scenario('a second tab holding the mint lock prevents a duplicate prompt', {}, async h => {
    await h.connect();
    const second = await h.context.newPage(); await second.goto(`${origin}/devnet/`);
    await second.evaluate(key => { navigator.locks.request(key, () => new Promise(resolve => { window.releaseLock = resolve; })); }, S.storageKey);
    await second.waitForFunction(() => typeof window.releaseLock === 'function');
    await h.page.locator('#mint').click(); await h.status(/другой вкладке/);
    assert.equal(h.walletCalls, 0);
    await second.evaluate(() => window.releaseLock()); await second.close();
  });
  await scenario('late Wallet Standard Backpack registration connects and receives explicit Devnet', { provider: null }, async h => {
    assert.equal(await h.page.locator('#other-wallets').isVisible(), false);
    await h.page.evaluate(() => window.matrix.register('Backpack'));
    await h.page.waitForFunction(() => document.querySelector('#backpack'));
    await h.connect('backpack');
    await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    assert.equal(await h.page.evaluate(() => window.matrix.standardRequestVerified), true);
    assert.equal(h.walletCalls, 1);
    await h.page.evaluate(() => window.matrix.standardChange?.({ accounts: [] }));
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
  });
  await scenario('unsupported legacy transaction wallet is not offered', { provider: null }, async h => {
    await h.page.evaluate(() => window.matrix.register('LegacyOnly', 'solana:devnet', ['legacy']));
    assert.equal(await h.page.locator('#wallet-choice option').count(), 0);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('injected Solflare connects and follows the same guarded signing flow', { provider: 'Solflare' }, async h => {
    await h.connect('solflare'); await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    assert.equal(h.walletCalls, 1); assert.equal(await h.page.evaluate(() => window.matrix.journalVerified), true);
  });
  for (const [name, id, host] of [['Phantom', 'phantom', 'phantom.app'], ['Solflare', 'solflare', 'solflare.com'], ['Backpack', 'backpack', 'backpack.app']]) await scenario(`Android Chrome ${name} button opens its in-app browser link`, { provider: null, mobile: true, userAgent: mobileUA }, async h => {
    await h.page.locator(`#${id}`).click();
    await h.page.waitForURL(url => url.hostname === host);
    assert.equal(h.links.length, 1);
    assert.match(decodeURIComponent(h.links[0]), /https:\/\/coolbears-nfts\.com\/devnet\//);
    assert.equal(h.walletCalls, 0); assert.equal(h.requests.length, 0);
  });
  await scenario('desktop without a wallet shows a connection instruction', { provider: null, viewport: { width: 1440, height: 960 } }, async h => {
    await h.page.locator('#phantom').click(); await h.status(/Phantom|расширен/);
    assert.equal(h.links.length, 0); assert.equal(h.walletCalls, 0);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
  });
  await scenario('custom RPC passes genesis verification without persisting endpoint credentials', {}, async h => {
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    assert.equal(await h.page.locator('#rpc-endpoint').getAttribute('type'), 'password');
    await h.page.locator('#rpc-endpoint').fill(customRpc); await h.page.locator('#rpc-apply').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    await h.connect();
    assert.equal(h.requests.some(item => item.custom), true);
    assert.equal(await h.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('matrix-public-fixture-key')), false);
    assert.equal((await h.page.locator('#rpc-current').textContent()).includes('matrix-public-fixture-key'), false);
    const [download] = await Promise.all([h.page.waitForEvent('download'), h.page.locator('#download').click()]);
    const exported = await readFile(await download.path(), 'utf8');
    assert.equal(exported.includes('matrix-public-fixture-key'), false);
    const before = h.requests.length; await h.page.reload({ waitUntil: 'networkidle' });
    assert.equal(h.requests.length, before);
    await h.connect(); assert.equal(h.requests.slice(before).every(item => !item.custom), true);
  });
  await scenario('custom RPC rejects wrong chain and public reset restores a usable endpoint', {}, async h => {
    h.customMode = 'wrong-genesis';
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    await h.page.locator('#rpc-endpoint').fill(customRpc); await h.page.locator('#rpc-apply').click(); await h.status(/Требуется Solana Devnet/);
    assert.equal(h.walletCalls, 0);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    await h.page.locator('#rpc-reset').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    await h.connect();
    assert.equal(h.requests.at(-1).custom, false);
  });
  await scenario('custom RPC refuses non-HTTPS, credentials and fragments before network access', {}, async h => {
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    for (const endpoint of ['http://custom-rpc.example', 'https://custom-rpc.example/#fragment', 'https://user:secret@custom-rpc.example']) {
      await h.page.locator('#rpc-endpoint').fill(endpoint); await h.page.locator('#rpc-apply').click();
      await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
      assert.equal(h.requests.length, 0, endpoint);
    }
    assert.equal(h.walletCalls, 0);
  });
  complete = true;
} finally {
  const report = {
    checkedAt: new Date().toISOString(), engine, deterministicFixtures: true,
    realWallets: false, realTransactionsSent: 0, rpcTransactionSubmissionRequests: totalRpcWrites,
    physicalDevicesTested: false, browsersNotExecuted: ['chromium', 'firefox', 'webkit'].filter(name => name !== engine),
    limitations: ['Viewport and user-agent profiles do not execute Android, iOS, or wallet-app internals. Firefox uses viewport and touch without isMobile emulation.', 'RPC and wallet results are deterministic fixtures; provider uptime and live wallet approval screens are outside this test.', 'No guarantee of absence of all defects is possible.'],
    passed: complete && cases.length > 0 && cases.every(item => item.passed), cases,
  };
  await writeFile(path.join(output, 'browser-matrix.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, scenarios: cases.length, report: path.join(output, 'browser-matrix.json') }));
}
