// Deterministic browser integration. Wallets and RPC are fixtures: no external
// requests, private keys, real wallet approvals, or blockchain submissions.
// This does not emulate the internals of mobile wallet apps or Safari/Firefox.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { getCandyMachineAccountDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { settings as S } from '../devnet/settings.mjs';

const playwright = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const engine = process.env.COOLBEARS_ENGINE || 'chromium';
const output = process.env.COOLBEARS_BROWSER_OUTPUT || 'build/browser-matrix';
await mkdir(output, { recursive: true });
const fixture = JSON.parse(await readFile('tests/fixtures/devnet-rpc.json', 'utf8'));
const assetFixture = JSON.parse(await readFile('tests/fixtures/devnet-existing-asset.json', 'utf8'));
const exhaustedAccounts = structuredClone(fixture.getMultipleAccounts);
const machineBytes = Buffer.from(exhaustedAccounts.value[0].data[0], 'base64');
const machineSerializer = getCandyMachineAccountDataSerializer();
const [machine] = machineSerializer.deserialize(machineBytes);
machineBytes.set(machineSerializer.serialize({ ...machine, itemsRedeemed: 2n }));
exhaustedAccounts.value[0].data[0] = machineBytes.toString('base64');
const signature = '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7';
const origin = 'https://coolbears-nfts.com';
const customRpc = 'https://custom-rpc.example/devnet?api-key=matrix-public-fixture-key';
const untrustedWalletMessage = `matrix-untrusted-wallet-message <b>matrix-secret-extra</b> ${customRpc}`;
const mobileUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const browser = await playwright[engine].launch({
  executablePath: process.env.COOLBEARS_CHROMIUM || undefined,
  headless: true, args: engine === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'] : [],
});
const cases = [];
const scenarioFilter = process.env.COOLBEARS_SCENARIO_FILTER ? new RegExp(process.env.COOLBEARS_SCENARIO_FILTER) : null;
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
  await page.exposeFunction('matrixCustomRpcMode', mode => { h.customMode = mode; });
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
    if (rpc.method === 'sendTransaction') {
      totalRpcWrites++;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'Negative wallet fixture must never submit' } }) });
    }
    const mode = url.hostname === 'custom-rpc.example' ? h.customMode : h.mode;
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === '429' || (mode === '429-once' && h.retryCount++ === 0)) {
      return route.fulfill({ status: 429, headers: { 'retry-after': '0', 'access-control-allow-origin': origin }, body: '{}' });
    }
    if (rpc.method === 'getMultipleAccounts' && (mode.startsWith('expired') || mode === 'failed')) {
      h.stageBeforeReadiness = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).stage, S.storageKey);
      if (mode === 'expired-refresh-error') return route.fulfill({ status: 403, headers: { 'access-control-allow-origin': origin }, body: '{}' });
    }
    let result = structuredClone(fixture[rpc.method]);
    if (rpc.method === 'getMultipleAccounts' && mode === 'expired-exhausted') result = structuredClone(exhaustedAccounts);
    if (rpc.method === 'getGenesisHash' && mode === 'wrong-genesis') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    if (rpc.method === 'getBalance' && mode === 'insufficient') result.value = 100;
    if (rpc.method === 'simulateTransaction') result = { context: { slot: 502145500 }, value: { err: mode === 'simulation-error' ? { InstructionError: [1, { Custom: 6033 }] } : null, logs: [], unitsConsumed: 57949 } };
    if (rpc.method === 'getSignaturesForAddress') result = ['finalized', 'signature-before-outage'].includes(mode) ? [{ signature, err: null }] : [];
    if (rpc.method === 'getSignatureStatuses') result = { context: { slot: 502145500 }, value: [mode === 'finalized' ? { slot: 502145500, confirmationStatus: 'finalized', err: null } : null] };
    if (rpc.method === 'getSignatureStatuses' && mode === 'failed') result.value[0] = { slot: 502145500, confirmationStatus: 'finalized', err: { InstructionError: [1, 'Custom'] } };
    if (rpc.method === 'getAccountInfo') {
      result = ['finalized', 'signature-before-outage'].includes(mode) ? assetFixture : { context: { slot: 502145500 }, value: null };
      // Simulate lagging signature-status lookup, then loss of connectivity.
      // Recovery must durably retain the signature before the next poll fails.
      if (mode === 'signature-before-outage') h.mode = 'offline';
    }
    if (rpc.method === 'isBlockhashValid') result = { context: { slot: 502145500 }, value: !mode.startsWith('expired') };
    if (rpc.method === 'getBlockHeight') result = fixture.getLatestBlockhash.value.lastValidBlockHeight + (mode.startsWith('expired') ? 1 : mode === 'stale-blockhash' ? -99 : -140);
    assert.notEqual(result, undefined, `Missing RPC fixture: ${rpc.method}`);
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) });
  });
  await page.addInitScript(({ owner, key, sig, signatureBytes, ownerBytes, providerName, storage, ownerOverride, shortWalletDeadline, untrustedWalletMessage, signOnly, noDefaultSend }) => {
    if (shortWalletDeadline) {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 60000 ? 150 : delay, ...args);
    }
    window.matrix = { walletCalls: 0, signOnlyCalls: 0, injectedSendCalls: 0, standardSendCalls: 0, connectCalls: 0, walletMode: 'reject', signMode: 'reject', journalVerified: false, options: null, change: null };
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
        window.matrix.walletCalls++; window.matrix.injectedSendCalls++; await window.matrixWalletCall();
        const saved = JSON.parse(localStorage.getItem(key));
        if (!saved?.asset || saved.stage !== 'wallet-pending') throw Error('Journal not persisted before wallet prompt');
        if (saved.walletAttempt?.wallet !== 'phantom' && saved.walletAttempt?.wallet !== 'solflare') throw Error('Wallet attempt identity not persisted before wallet prompt');
        if (saved.walletAttempt.transport !== 'injected' || saved.walletAttempt.outcome !== 'pending' || !Number.isFinite(Date.parse(saved.walletAttempt.requestedAt))) throw Error('Pending wallet attempt not persisted before wallet prompt');
        if (transaction.version !== 0 || !transaction.signatures.some(bytes => bytes.some(byte => byte !== 0)) || options.skipPreflight !== false) throw Error('Invalid partial transaction');
        window.matrix.journalVerified = true;
        window.matrix.options = options;
        if (window.matrix.walletMode === 'hold') return new Promise((resolve, reject) => {
          window.matrix.rejectWallet = () => reject(Object.assign(Error('Rejected'), { code: 4001 }));
          window.matrix.failWallet = () => reject(Object.assign(Error(untrustedWalletMessage), { code: -32603, data: { message: untrustedWalletMessage } }));
          window.matrix.resolveWallet = () => resolve({ signature: sig });
        });
        if (window.matrix.walletMode === 'reject') throw Object.assign(Error('Rejected'), { code: 4001 });
        if (window.matrix.walletMode === 'error') {
          await window.matrixRpcMode('expired');
          throw Object.assign(Error(untrustedWalletMessage), { code: -32603, data: { message: untrustedWalletMessage } });
        }
        if (window.matrix.walletMode === 'unknown') { await window.matrixRpcMode('offline'); throw Error('Wallet disconnected'); }
        return { signature: sig };
      },
    };
    if (signOnly) provider.signTransaction = async transaction => {
      window.matrix.walletCalls++; window.matrix.signOnlyCalls++; await window.matrixWalletCall();
      const saved = JSON.parse(localStorage.getItem(key));
      if (!saved?.asset || saved.stage !== 'wallet-pending' || saved.walletAttempt?.method !== 'signTransaction' || saved.walletAttempt?.outcome !== 'pending') throw Error('Sign-only journal not persisted before wallet prompt');
      if (transaction.version !== 0 || !transaction.signatures.some(bytes => bytes.some(byte => byte !== 0))) throw Error('Invalid sign-only partial transaction');
      window.matrix.signOnlyJournalVerified = true;
      if (window.matrix.signMode === 'hold') return new Promise(() => {});
      if (window.matrix.signMode === 'reject') throw Object.assign(Error('Rejected'), { code: 4001 });
      // Invalid responses and errors will be followed by read-only expiry proof.
      // This fixture never creates an owner signature or submits a transaction.
      await window.matrixCustomRpcMode('expired');
      if (window.matrix.signMode === 'error') throw Object.assign(Error(untrustedWalletMessage), { code: -32603 });
      if (window.matrix.signMode === 'modified') transaction.message.recentBlockhash = '11111111111111111111111111111111';
      return transaction;
    };
    if (noDefaultSend) delete provider.signAndSendTransaction;
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
            await window.matrixWalletCall(); window.matrix.walletCalls++; window.matrix.standardSendCalls++;
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
  }, { owner: S.owner, key: S.storageKey, sig: signature, signatureBytes: Array.from(base58.serialize(signature)), ownerBytes: Array.from(base58.serialize(S.owner)), providerName: options.provider === undefined ? 'Phantom' : options.provider, storage: options.storage, ownerOverride: options.owner, shortWalletDeadline: options.shortWalletDeadline, untrustedWalletMessage, signOnly: options.signOnly, noDefaultSend: options.noDefaultSend });
  await page.goto(`${origin}/devnet/`, { waitUntil: 'networkidle' });
  h.status = async pattern => page.waitForFunction(source => new RegExp(source).test(document.querySelector('#status').textContent), pattern.source, { timeout: 15000 });
  h.connect = async (id = 'phantom') => { await page.locator(`#${id}`).click(); await page.waitForFunction(() => !document.querySelector('#mint').disabled); };
  return h;
}

async function scenario(name, options, body) {
  if (scenarioFilter && !scenarioFilter.test(name)) return;
  const started = Date.now();
  const h = await makeHarness(options);
  try {
    await body(h);
    assert.deepEqual(h.errors, [], `${name}: unexpected page errors or external requests`);
    assert.equal(totalRpcWrites, 0, 'These negative wallet fixtures must not submit RPC transactions');
    cases.push({ name, passed: true, durationMs: Date.now() - started, mockedWalletCalls: h.walletCalls, rpcReadAndSimulationRequests: h.requests.length });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, passed: false, error: error.message, status: await h.page.locator('#status').textContent().catch(() => null), pageErrors: h.errors });
    await h.page.screenshot({ path: path.join(output, `failure-${cases.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await h.context.close(); }
}

async function prepareDiagnosticChecks(h, clipboard, pending = null) {
  if (pending) {
    await h.page.evaluate(({ key, pending }) => localStorage.setItem(key, JSON.stringify(pending)), { key: S.storageKey, pending });
    await h.page.reload({ waitUntil: 'networkidle' });
  }
  let downloads = 0;
  h.page.on('download', () => { downloads++; });
  await h.page.evaluate(clipboard => {
    window.matrixClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard === 'absent' ? undefined : {
        async writeText(text) {
          window.matrixClipboardWrites.push(text);
          if (clipboard === 'reject') throw new DOMException('Clipboard rejected by fixture', 'NotAllowedError');
        },
      },
    });
    window.matrixStorageMutations = [];
    for (const name of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (...args) {
        window.matrixStorageMutations.push(name);
        return original.apply(this, args);
      };
    }
  }, clipboard);
  return async () => {
    const before = {
      requests: h.requests.length, walletCalls: h.walletCalls,
      state: await h.page.evaluate(key => ({
        journal: localStorage.getItem(key), connectCalls: window.matrix.connectCalls,
        storage: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        mutations: window.matrixStorageMutations.length,
      }), S.storageKey),
    };
    return async () => {
      assert.equal(h.requests.length, before.requests, 'Viewing or copying the report must not contact RPC');
      assert.equal(h.walletCalls, before.walletCalls, 'Viewing or copying must not request a signature');
      assert.equal(downloads, 0, 'Inline report and clipboard fallback must not start a download');
      assert.deepEqual(await h.page.evaluate(key => ({
        journal: localStorage.getItem(key), connectCalls: window.matrix.connectCalls,
        storage: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        mutations: window.matrixStorageMutations.length,
      }), S.storageKey), before.state, 'The report must preserve the pending journal and avoid storage writes');
    };
  };
}

async function openDiagnosticReport(h) {
  await h.page.locator('#diagnostic-report summary').click();
  await h.page.waitForFunction(() => document.querySelector('#report-text')?.value.length > 0);
  assert.equal(await h.page.locator('#report-text').isVisible(), true);
  assert.equal(await h.page.locator('#report-text').evaluate(node => node.readOnly), true);
  const text = await h.page.locator('#report-text').inputValue();
  assert.equal(text.includes('matrix-public-fixture-key'), false, 'The report must not contain an RPC API key');
  assert.equal(text.includes(customRpc), false, 'The report must not contain the full RPC endpoint');
  assert.equal(text.includes('matrix-secret-extra'), false, 'Unrecognized journal properties must not leak into the report');
  assert.equal(text.includes('matrix-untrusted-wallet-message'), false, 'Raw wallet errors must not leak into the report');
  const report = JSON.parse(text);
  assert.equal(report.page, `${origin}/devnet/`);
  assert.equal(report.appVersion, 'devnet-20260922-6');
  assert.equal(Number.isNaN(Date.parse(report.exportedAt)), false);
  return { text, report };
}

function assertWalletAttempt(attempt, outcome, { timedOut = false } = {}) {
  assert.equal(attempt.wallet, 'phantom');
  assert.equal(attempt.transport, 'injected');
  assert.equal(attempt.outcome, outcome);
  assert.equal(Number.isNaN(Date.parse(attempt.requestedAt)), false);
  if (timedOut) {
    assert.equal(Number.isNaN(Date.parse(attempt.timeoutAt)), false);
    assert.equal(Date.parse(attempt.timeoutAt) >= Date.parse(attempt.requestedAt), true);
  } else assert.equal(attempt.timeoutAt, undefined);
  if (outcome === 'pending') assert.equal(attempt.responseAt, undefined);
  else {
    assert.equal(Number.isNaN(Date.parse(attempt.responseAt)), false);
    assert.equal(Date.parse(attempt.responseAt) >= Date.parse(attempt.requestedAt), true);
  }
  if (outcome === 'error') {
    assert.equal(attempt.errorCategory, 'wallet-error');
    assert.equal(attempt.errorCode, -32603);
  }
  if (outcome === 'rejected') {
    assert.equal(attempt.errorCategory, 'user-rejected');
    assert.equal(attempt.errorCode, 4001);
  }
}

async function selectCustomRpc(h) {
  await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
  await h.page.locator('#rpc-endpoint').fill(customRpc);
  await h.page.locator('#rpc-apply').click();
  await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
}

async function selectPhantomRpc(h) {
  await selectCustomRpc(h);
  assert.equal(await h.page.locator('#phantom-rpc').isVisible(), true);
  await h.connect('phantom-rpc');
  assert.match(await h.page.locator('#wallet-route').textContent(), /RPC/i);
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
  await scenario('stale blockhash stops before any wallet request or journal is created', {}, async h => {
    await h.connect(); h.mode = 'stale-blockhash';
    await h.page.locator('#mint').click(); await h.status(/Подпись не запрашивалась/);
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(h.walletCalls, 0);
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), S.storageKey), null);
    assert.equal(h.requests.filter(item => item.method === 'getBlockHeight').length, 2, 'Only one bounded fresh preparation is allowed');
    assert.equal(h.requests.some(item => item.method === 'getSignaturesForAddress'), false);
  });
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
  await scenario('non-4001 wallet error survives expired recovery and reload without leaking raw text', {}, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'error'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const savedText = await h.page.evaluate(key => localStorage.getItem(key), S.storageKey);
    const expired = JSON.parse(savedText);
    assert.equal(expired.stage, 'expired');
    assert.equal(expired.signature, null);
    assertWalletAttempt(expired.walletAttempt, 'error');
    assert.equal(savedText.includes(untrustedWalletMessage), false);
    assert.equal(savedText.includes('matrix-public-fixture-key'), false);
    const first = await openDiagnosticReport(h);
    assert.equal(first.report.operation.stage, 'expired');
    assert.deepEqual(first.report.operation.walletAttempt, expired.walletAttempt);
    const requests = h.requests.length;
    await h.page.reload({ waitUntil: 'networkidle' });
    assert.equal(h.requests.length, requests, 'Reload must not resubmit or automatically check the failed wallet attempt');
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), S.storageKey), savedText);
    const reloaded = await openDiagnosticReport(h);
    assert.deepEqual(reloaded.report.operation.walletAttempt, expired.walletAttempt);
    assert.equal(reloaded.report.operation.asset, expired.asset);
    assert.equal(reloaded.report.operation.stage, 'expired');
    assert.equal(h.walletCalls, 1);
  });
  for (const mode of ['expired', 'expired-exhausted', 'expired-refresh-error', 'failed']) {
    await scenario(`terminal recovery refreshes readiness after reload: ${mode}`, { mode }, async h => {
      const saved = {
        version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection, owner: S.owner,
        asset: 'J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57',
        blockhash: fixture.getLatestBlockhash.value.blockhash,
        lastValidBlockHeight: fixture.getLatestBlockhash.value.lastValidBlockHeight,
        stage: 'unknown', signature: mode === 'failed' ? signature : null,
      };
      await h.page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: S.storageKey, saved });
      await h.page.reload({ waitUntil: 'networkidle' });
      assert.equal(h.requests.length, 0, 'Reload must not automatically recover or contact a wallet');
      await h.page.locator('#phantom').click();
      await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
      const recovered = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
      const terminal = mode === 'failed' ? 'failed' : 'expired';
      assert.equal(recovered.stage, terminal);
      assert.equal(recovered.asset, saved.asset);
      assert.equal(h.stageBeforeReadiness, terminal, 'Persist terminal proof before the next RPC check');
      assert.equal(await h.page.locator('#wallet').textContent(), S.owner);
      assert.equal(await h.page.locator('#mint').isDisabled(), !['expired', 'failed'].includes(mode));
      const status = await h.page.locator('#status').textContent();
      if (mode === 'expired-exhausted') {
        assert.match(status, /Оба тестовых NFT уже выпущены/);
        assert.doesNotMatch(status, /Можно начать новую попытку/);
      } else if (mode === 'expired-refresh-error') assert.match(status, /403/);
      else assert.match(status, /Можно начать новую попытку/);
      assert.equal(h.walletCalls, 0, 'Recovery must never request a signature or submit another mint');
    });
  }
  await scenario('late wallet signature after an accelerated timeout remains recoverable', { shortWalletDeadline: true }, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'hold'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => typeof window.matrix.resolveWallet === 'function');
    h.mode = 'offline';
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const unknown = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(unknown.stage, 'unknown'); assert.equal(unknown.signature, null);
    assertWalletAttempt(unknown.walletAttempt, 'pending', { timedOut: true });
    await h.page.evaluate(() => window.matrix.resolveWallet());
    await h.page.waitForFunction(({ key, signature }) => JSON.parse(localStorage.getItem(key)).signature === signature, { key: S.storageKey, signature });
    h.mode = 'finalized'; await h.page.locator('#check').click(); await h.status(/NFT выпущен и проверен/);
    const recovered = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(recovered.asset, unknown.asset); assert.equal(recovered.signature, signature); assert.equal(recovered.stage, 'verified');
    assertWalletAttempt(recovered.walletAttempt, 'submitted', { timedOut: true });
    assert.equal(recovered.walletAttempt.timeoutAt, unknown.walletAttempt.timeoutAt);
    const { report } = await openDiagnosticReport(h);
    assert.deepEqual(report.operation.walletAttempt, recovered.walletAttempt);
    assert.equal(h.walletCalls, 1);
  });
  await scenario('late wallet error after an accelerated timeout remains in the expired diagnostic report', { shortWalletDeadline: true }, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'hold'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => typeof window.matrix.failWallet === 'function');
    h.mode = 'offline';
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const unknown = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(unknown.stage, 'unknown'); assert.equal(unknown.signature, null);
    assertWalletAttempt(unknown.walletAttempt, 'pending', { timedOut: true });
    await h.page.evaluate(() => window.matrix.failWallet());
    await h.page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).walletAttempt?.outcome === 'error', S.storageKey);
    h.mode = 'expired'; await h.page.locator('#check').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const expired = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(expired.asset, unknown.asset); assert.equal(expired.signature, null); assert.equal(expired.stage, 'expired');
    assertWalletAttempt(expired.walletAttempt, 'error', { timedOut: true });
    assert.equal(expired.walletAttempt.timeoutAt, unknown.walletAttempt.timeoutAt);
    const { report } = await openDiagnosticReport(h);
    assert.deepEqual(report.operation.walletAttempt, expired.walletAttempt);
    assert.equal(report.operation.stage, 'expired');
    assert.equal(h.walletCalls, 1);
  });
  await scenario('late wallet rejection cannot cancel a signature already found by recovery', { shortWalletDeadline: true }, async h => {
    await h.connect(); await h.page.evaluate(() => { window.matrix.walletMode = 'hold'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => typeof window.matrix.rejectWallet === 'function');
    h.mode = 'offline';
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    const timedOut = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(timedOut.stage, 'unknown'); assert.equal(timedOut.signature, null);
    assertWalletAttempt(timedOut.walletAttempt, 'pending', { timedOut: true });

    h.mode = 'signature-before-outage'; await h.page.locator('#check').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled, undefined, { timeout: 20000 });
    const discovered = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(discovered.asset, timedOut.asset); assert.equal(discovered.signature, signature); assert.equal(discovered.stage, 'unknown');
    assert.equal(h.requests.some(item => item.method === 'getSignaturesForAddress'), true);

    await h.page.evaluate(() => window.matrix.rejectWallet());
    await h.page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).walletAttempt?.outcome === 'rejected', S.storageKey);
    const rejected = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(rejected.asset, discovered.asset); assert.equal(rejected.signature, signature); assert.equal(rejected.stage, 'unknown');
    assertWalletAttempt(rejected.walletAttempt, 'rejected', { timedOut: true });
    assert.equal(rejected.walletAttempt.timeoutAt, timedOut.walletAttempt.timeoutAt);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.operation.stage, 'unknown'); assert.equal(report.operation.signature, signature);
    assert.deepEqual(report.operation.walletAttempt, rejected.walletAttempt);
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
  await scenario('explicit Phantom RPC route coexists with the default Wallet Standard route', { signOnly: true }, async h => {
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    assert.equal(await h.page.locator('#phantom-rpc').isVisible(), false, 'Sign-only send must be unavailable on public RPC');
    await h.page.evaluate(() => window.matrix.register('Phantom'));
    await selectCustomRpc(h);
    await h.connect('phantom');
    await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    assert.deepEqual(await h.page.evaluate(() => ({ standard: window.matrix.standardSendCalls, injectedSend: window.matrix.injectedSendCalls, signOnly: window.matrix.signOnlyCalls })), { standard: 1, injectedSend: 0, signOnly: 0 });

    await h.connect('phantom-rpc');
    assert.match(await h.page.locator('#wallet-route').textContent(), /RPC/i);
    await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    const rejected = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
    assert.equal(rejected.stage, 'cancelled'); assert.equal(rejected.signature, null);
    assertWalletAttempt(rejected.walletAttempt, 'rejected');
    assert.equal(rejected.walletAttempt.method, 'signTransaction');
    assert.equal(await h.page.evaluate(() => window.matrix.signOnlyJournalVerified), true);
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.walletRoute, 'custom-rpc');
    assert.equal(report.operation.submission, undefined);
    assert.equal(report.operation.walletAttempt.method, 'signTransaction');
    assert.deepEqual(await h.page.evaluate(() => ({ standard: window.matrix.standardSendCalls, injectedSend: window.matrix.injectedSendCalls, signOnly: window.matrix.signOnlyCalls })), { standard: 1, injectedSend: 0, signOnly: 1 });

    await h.connect('phantom');
    await h.page.locator('#mint').click(); await h.status(/Подпись отменена/);
    assert.deepEqual(await h.page.evaluate(() => ({ standard: window.matrix.standardSendCalls, injectedSend: window.matrix.injectedSendCalls, signOnly: window.matrix.signOnlyCalls })), { standard: 2, injectedSend: 0, signOnly: 1 });
    assert.equal(h.walletCalls, 3);
    assert.equal(h.requests.some(item => item.method === 'sendTransaction'), false);
  });
  await scenario('Phantom RPC accepts a sign-only provider and resetting RPC invalidates that route', { signOnly: true, noDefaultSend: true }, async h => {
    await selectPhantomRpc(h);
    assert.equal(await h.page.locator('#wallet').textContent(), S.owner);
    assert.equal(h.walletCalls, 0, 'Selecting the route must not request a signature');
    await h.page.locator('#rpc-reset').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.equal(await h.page.locator('#phantom-rpc').isVisible(), false);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.match(await h.page.locator('#wallet').textContent(), /не подключ[её]н/);
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.walletRoute, 'none'); assert.equal(report.rpc, 'public-devnet');
    assert.equal(report.operation, null); assert.equal(h.walletCalls, 0);
  });
  await scenario('Phantom RPC simulated BFCache return requires reconnection and restores account-change handling', { signOnly: true }, async h => {
    await selectPhantomRpc(h);
    const connects = await h.page.evaluate(() => window.matrix.connectCalls);
    const requests = h.requests.length;
    await h.page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    assert.match(await h.page.locator('#wallet').textContent(), /не подключ[её]н/);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(await h.page.evaluate(() => window.matrix.connectCalls), connects, 'Returning from cache must not reconnect automatically');
    assert.equal(h.requests.length, requests, 'Returning from cache must not automatically resume RPC work');
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.walletRoute, 'none');
    assert.equal(report.walletConnected, false);

    await h.connect('phantom-rpc');
    assert.equal(await h.page.evaluate(() => window.matrix.connectCalls), connects + 1);
    assert.equal(await h.page.locator('#wallet').textContent(), S.owner);
    await h.page.evaluate(() => window.matrix.change()); await h.status(/Аккаунт кошелька изменился/);
    assert.match(await h.page.locator('#wallet').textContent(), /не подключ[её]н/);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(h.walletCalls, 0);
  });
  await scenario('Phantom RPC route stays unavailable without an injected signing capability', {}, async h => {
    await selectCustomRpc(h);
    assert.equal(await h.page.locator('#phantom-rpc').isVisible(), false);
    assert.equal(h.walletCalls, 0);
  });
  for (const mode of ['error', 'unsigned', 'modified']) {
    await scenario(`Phantom RPC ${mode} response cannot reach transaction submission`, { signOnly: true }, async h => {
      await selectPhantomRpc(h);
      await h.page.evaluate(mode => { window.matrix.signMode = mode; }, mode);
      await h.page.locator('#mint').click();
      await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
      const saved = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
      assert.equal(saved.signature, null);
      assert.equal(saved.walletAttempt.method, 'signTransaction');
      assert.equal(saved.walletAttempt.outcome, 'error');
      assert.equal(saved.submission, undefined);
      if (mode === 'error') assertWalletAttempt(saved.walletAttempt, 'error');
      assert.equal(await h.page.evaluate(() => window.matrix.signOnlyJournalVerified), true);
      assert.deepEqual(await h.page.evaluate(() => ({ standard: window.matrix.standardSendCalls, injectedSend: window.matrix.injectedSendCalls, signOnly: window.matrix.signOnlyCalls })), { standard: 0, injectedSend: 0, signOnly: 1 });
      assert.equal(h.requests.some(item => item.method === 'sendTransaction'), false);
      const { report } = await openDiagnosticReport(h);
      assert.equal(report.walletRoute, 'custom-rpc'); assert.equal(report.rpc, 'custom-devnet');
      assert.equal(report.operation.signature, null); assert.equal(report.operation.submission, undefined);
      assert.equal(report.operation.walletAttempt.method, 'signTransaction');
      assert.equal(report.operation.walletAttempt.outcome, 'error');
      assert.equal(h.walletCalls, 1);
    });
  }
  await scenario('Phantom RPC pending signature survives reload without signing or submitting again', { signOnly: true }, async h => {
    await selectPhantomRpc(h);
    await h.page.evaluate(() => { window.matrix.signMode = 'hold'; });
    await h.page.locator('#mint').click();
    await h.page.waitForFunction(() => window.matrix.signOnlyJournalVerified === true);
    const savedText = await h.page.evaluate(key => localStorage.getItem(key), S.storageKey);
    const pending = JSON.parse(savedText);
    assert.equal(pending.stage, 'wallet-pending'); assert.equal(pending.signature, null);
    assert.equal(pending.walletAttempt.method, 'signTransaction');
    assertWalletAttempt(pending.walletAttempt, 'pending');
    const requests = h.requests.length;
    await h.page.reload({ waitUntil: 'networkidle' });
    assert.equal(h.requests.length, requests, 'Reload must not restart the selected RPC flow');
    assert.equal(h.walletCalls, 1, 'Reload must not reopen the sign-only wallet prompt');
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), S.storageKey), savedText);
    assert.equal(await h.page.locator('#mint').isDisabled(), true);
    assert.equal(await h.page.locator('#phantom-rpc').isVisible(), false);
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.walletRoute, 'none'); assert.equal(report.rpc, 'public-devnet');
    assert.equal(report.operation.asset, pending.asset);
    assert.deepEqual(report.operation.walletAttempt, pending.walletAttempt);
    assert.equal(report.operation.submission, undefined);
  });
  for (const clipboard of ['reject', 'absent', 'success']) {
    await scenario(`inline diagnostic report preserves a pending journal: clipboard ${clipboard}`, {}, async h => {
      const pending = {
        version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection, owner: S.owner,
        asset: 'J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57',
        blockhash: fixture.getLatestBlockhash.value.blockhash,
        lastValidBlockHeight: fixture.getLatestBlockhash.value.lastValidBlockHeight,
        stage: 'unknown', signature: null, createdAt: '2026-09-22T00:00:00.000Z',
      };
      const stored = clipboard === 'reject' ? { ...pending, debugEndpoint: customRpc, privateNote: 'matrix-secret-extra' } : pending;
      const checkpoint = await prepareDiagnosticChecks(h, clipboard, stored);
      if (clipboard === 'reject') {
        h.customMode = '429';
        await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
        await h.page.locator('#rpc-endpoint').fill(customRpc);
        await h.page.locator('#rpc-apply').click(); await h.status(/429/);
        await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
        assert.equal(await h.page.locator('#mint').isDisabled(), true);
      }
      const unchanged = await checkpoint();
      const { text, report } = await openDiagnosticReport(h);
      assert.equal(report.storageError, false);
      assert.equal(report.rpc, clipboard === 'reject' ? 'custom-devnet' : 'public-devnet');
      assert.equal(report.rpcProvider, clipboard === 'reject' ? 'other' : 'solana-public');
      for (const key of ['cluster', 'machine', 'collection', 'owner', 'asset', 'blockhash', 'lastValidBlockHeight', 'stage', 'signature']) {
        assert.deepEqual(report.operation[key], pending[key], `Recovery coordinate ${key} must remain readable`);
      }
      assert.equal('debugEndpoint' in report.operation, false);
      assert.equal('privateNote' in report.operation, false);
      if (clipboard === 'reject') assert.match(report.status, /429/);
      await unchanged();
      await h.page.locator('#copy-report').click();
      if (clipboard === 'success') {
        await h.page.waitForFunction(() => window.matrixClipboardWrites.length === 1);
        assert.deepEqual(await h.page.evaluate(() => window.matrixClipboardWrites), [text]);
      } else {
        await h.page.waitForFunction(() => /выдел|вручную/i.test(document.querySelector('#report-copy-status').textContent));
        assert.deepEqual(await h.page.locator('#report-text').evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node })), { start: 0, end: text.length, focused: true });
        assert.deepEqual(await h.page.evaluate(() => window.matrixClipboardWrites), clipboard === 'reject' ? [text] : []);
      }
      assert.equal(await h.page.locator('#report-text').inputValue(), text, 'Copying must preserve the visible report');
      await unchanged();
    });
  }
  await scenario('inline diagnostic report recognizes a manually pasted public RPC', {}, async h => {
    const checkpoint = await prepareDiagnosticChecks(h, 'success');
    await h.page.locator('#rpc-settings').evaluate(node => { node.open = true; });
    await h.page.locator('#rpc-endpoint').fill(S.rpc);
    await h.page.locator('#rpc-apply').click();
    await h.page.waitForFunction(() => !document.querySelector('#check').disabled);
    assert.match(await h.page.locator('#rpc-current').textContent(), /общий/i);
    const unchanged = await checkpoint();
    const { report } = await openDiagnosticReport(h);
    assert.equal(report.rpc, 'public-devnet');
    assert.equal(report.rpcProvider, 'solana-public');
    assert.equal(report.operation, null);
    await unchanged();
  });
  complete = true;
} finally {
  const report = {
    checkedAt: new Date().toISOString(), engine, scenarioFilter: scenarioFilter?.source ?? null, deterministicFixtures: true,
    realWallets: false, realTransactionsSent: 0, rpcTransactionSubmissionRequests: totalRpcWrites,
    physicalDevicesTested: false, browsersNotExecuted: ['chromium', 'firefox', 'webkit'].filter(name => name !== engine),
    limitations: ['Viewport and user-agent profiles do not execute Android, iOS, or wallet-app internals. Firefox uses viewport and touch without isMobile emulation.', 'RPC and wallet results are deterministic fixtures; provider uptime and live wallet approval screens are outside this test.', 'Sign-only browser cases exercise rejection and invalid responses, not a cryptographically valid owner signature or successful RPC submission.', 'No guarantee of absence of all defects is possible.'],
    passed: complete && cases.length > 0 && cases.every(item => item.passed), cases,
  };
  await writeFile(path.join(output, 'browser-matrix.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, scenarios: cases.length, report: path.join(output, 'browser-matrix.json') }));
}
