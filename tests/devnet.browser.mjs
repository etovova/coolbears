// Browser acceptance with mocked RPC/wallet. Never signs with a real wallet.
// Supply COOLBEARS_PLAYWRIGHT (optional module path) and COOLBEARS_CHROMIUM
// (optional executable). Screenshots go to the requested scratch directory.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { settings as S } from '../devnet/settings.mjs';

const { chromium } = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.COOLBEARS_CHROMIUM || undefined,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'],
});
const fixtures = JSON.parse(await readFile('tests/fixtures/devnet-rpc.json', 'utf8'));
const assetFixture = JSON.parse(await readFile('tests/fixtures/devnet-existing-asset.json', 'utf8'));
const signature = '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7';
const output = process.env.COOLBEARS_BROWSER_OUTPUT || 'build/browser-check';
await mkdir(output, { recursive: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let mode = 'ready';
let rpcWrites = 0;
await page.route('https://api.devnet.solana.com/**', async route => {
  const request = route.request().postDataJSON();
  if (request.method === 'sendTransaction') rpcWrites++;
  if (mode === 'offline') return route.fulfill({ status: 503, body: '{}' });
  let result = fixtures[request.method];
  if (request.method === 'simulateTransaction') result = { context: { slot: 500000000 }, value: { err: null, logs: [], unitsConsumed: 57949 } };
  if (request.method === 'getSignaturesForAddress') result = mode === 'finalized' ? [{ signature, err: null }] : [];
  if (request.method === 'getSignatureStatuses') result = { context: { slot: 500000000 }, value: [mode === 'finalized' ? { slot: 500000000, confirmationStatus: 'finalized', err: null } : null] };
  if (request.method === 'getAccountInfo') result = mode === 'finalized' ? assetFixture : { context: { slot: 500000000 }, value: null };
  if (request.method === 'isBlockhashValid') result = { context: { slot: 500000000 }, value: true };
  if (request.method === 'getBlockHeight') result = fixtures.getLatestBlockhash.value.lastValidBlockHeight - 140;
  assert.notEqual(result, undefined, request.method);
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
});
await page.route('http://localhost/**', async route => {
  let name = new URL(route.request().url()).pathname;
  if (name.endsWith('/')) name += 'index.html';
  const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.gif') ? 'image/gif' : 'text/html';
  try { return await route.fulfill({ contentType: type, body: await readFile(path.join('public-site', name)) }); }
  catch { return route.fulfill({ status: 404, body: 'Not found' }); }
});
await page.addInitScript(({ owner, key, sig }) => {
  window.walletCalls = 0;
  window.walletMode = 'reject';
  const listeners = {};
  const provider = {
    isPhantom: true, publicKey: { toString: () => owner },
    async connect() { return { publicKey: this.publicKey }; },
    on(name, handler) { listeners[name] = handler; }, removeListener(name) { delete listeners[name]; },
    async signAndSendTransaction(transaction, options) {
      window.walletCalls++;
      const saved = JSON.parse(localStorage.getItem(key));
      if (!saved?.asset || saved.stage !== 'wallet-pending') throw Error('Journal not persisted before wallet prompt');
      if (transaction.version !== 0 || !transaction.signatures.some(bytes => bytes.some(byte => byte !== 0)) || options.skipPreflight !== false) throw Error('Invalid partial transaction');
      window.promptJournalVerified = true;
      if (window.walletMode === 'reject') throw Object.assign(Error('Rejected'), { code: 4001 });
      if (window.walletMode === 'unknown') { window.afterUnknown(); throw Error('Wallet disconnected'); }
      return { signature: sig };
    },
  };
  window.phantom = { solana: provider };
}, { owner: S.owner, key: S.storageKey, sig: signature });
await page.exposeFunction('afterUnknown', () => { mode = 'offline'; });

try {
  await page.goto('http://localhost/devnet/', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#mint').isDisabled(), true);
  assert.equal(await page.locator('body').evaluate(node => node.scrollWidth), 390);
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.locator('#phantom').click();
  await page.waitForFunction(() => !document.querySelector('#mint').disabled);
  await page.locator('#mint').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Подпись отменена'));
  assert.equal(await page.evaluate(() => window.walletCalls), 1);
  assert.equal(await page.evaluate(() => window.promptJournalVerified), true);
  assert.equal(await page.locator('#mint').isDisabled(), false);

  await page.evaluate(() => { window.walletMode = 'unknown'; });
  await page.locator('#mint').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('503'));
  assert.equal(await page.locator('#mint').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.walletCalls), 2);
  const savedAsset = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).asset, S.storageKey);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#mint').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.walletCalls), 0);
  mode = 'finalized';
  await page.locator('#check').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('NFT выпущен и проверен'));
  assert.equal(await page.evaluate(() => window.walletCalls), 0);
  const recovered = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), S.storageKey);
  assert.equal(recovered.asset, savedAsset);
  assert.equal(recovered.signature, signature);
  assert.equal(recovered.stage, 'verified');
  assert.equal(await page.locator('#mint').isDisabled(), true);
  assert.equal(rpcWrites, 0);
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), realWallet: false, realTransactionsSent: 0, assertions: ['mobile layout without overflow', 'desktop render', 'wallet connect and preflight', 'partially signed v0 transaction', 'journal before prompt', 'user rejection', 'unknown wallet outcome', 'reload without duplicate prompt', 'read-only finalized recovery', 'success requires verified Core asset'], pageErrors: errors };
  await writeFile('operator/reports/wallet-test-browser.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
