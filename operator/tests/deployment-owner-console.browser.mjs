// Actual browser + local server + SQLite-free durable file journal. Fixture wallet only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { prepareDeploymentSigning } from '../deployment/handoff.mjs';
import { readDeploymentJournal } from '../deployment/journal.mjs';
import { startSigningConsole } from '../deployment/owner-console/server.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
const playwright = await import(process.env.COOLBEARS_PLAYWRIGHT || 'playwright');
const engine = process.env.COOLBEARS_ENGINE || 'chromium';
const key = n => Keypair.fromSeed(createHash('sha256').update(`console-browser-${n}`).digest());
const owner = key('owner'), originalOwner = policy.owner;
const passphrase = Buffer.from('browser-fixture-encryption-passphrase'), endpoint = 'https://fixture-private-rpc.test/';
const output = path.resolve(`operator/build/owner-console-${engine}`);
await mkdir(output, { recursive: true });
policy.owner = owner.publicKey.toBase58();
const fixture = await createDeploymentSignerVault({ id: 'browser-console-fixture', cluster: 'devnet',
  blockhash: key('old').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000', passphrase });
const parent = await mkdtemp(path.join(tmpdir(), 'owner-console-browser-'));
const browser = await playwright[engine].launch({ headless: true, args: engine === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
const report = { engine, passed: false, realWallets: false, physicalPhones: false, liveRpc: false, transactionsSent: 0, cases: [], pageErrors: [] };
let server, context, signingCalls = 0, unexpectedExternal = 0;
async function open(name, { storageDenied = false } = {}) {
  const directory = path.join(parent, name);
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixture });
  let expired = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const rpc = JSON.parse(init.body); calls.push(rpc.method);
    const result = { getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
      getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
      getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('fresh').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 513 }, value: 10000 }, isBlockhashValid: { context: { slot: 514 }, value: !expired },
      getBlockHeight: 1500, simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    }[rpc.method];
    assert.notEqual(result, undefined); return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  };
  await prepareDeploymentSigning({ directory, stepId: 'collection-create', passphrase, endpoint, fetchImpl });
  server = await startSigningConsole({ directory, endpoint, fetchImpl, port: 0 });
  context = await browser.newContext({ viewport: { width: 1180, height: 1000 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== server.origin) { unexpectedExternal++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.exposeFunction('__fixtureSign', ({ bytes, mode }) => {
    signingCalls++;
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
    if (mode === 'changed') tx.message.recentBlockhash = key('altered').publicKey.toBase58();
    tx.sign([owner]); return Array.from(tx.serialize());
  });
  await page.addInitScript(({ address, publicKey, storageDenied }) => {
    if (storageDenied) Object.defineProperty(window, 'indexedDB', { get() { throw Error('Storage denied fixture'); } });
    window.__fixtureMode = 'ready';
    const account = { address, publicKey: Uint8Array.from(publicKey), chains: ['solana:devnet'], features: ['solana:signTransaction'] };
    const listeners = [];
    const wallet = { version: '1.0.0', name: 'Fixture Wallet', icon: 'data:image/svg+xml,<svg/>', chains: ['solana:devnet'],
      get accounts() { return window.__fixtureMode === 'wrong' ? [{ ...account, address: '11111111111111111111111111111111' }] : [account]; },
      features: {
        'standard:connect': { version: '1.0.0', async connect() { return { accounts: wallet.accounts }; } },
        'standard:events': { version: '1.0.0', on(_name, listener) { listeners.push(listener); return () => {}; } },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: [0], async signTransaction(input) {
          if (input.chain !== 'solana:devnet') throw Error('Wrong chain');
          if (window.__fixtureMode === 'cancel') throw Object.assign(Error('Cancelled'), { code: 4001 });
          if (window.__fixtureMode === 'unknown') throw Error('Unknown fixture outcome');
          const bytes = await window.__fixtureSign({ bytes: Array.from(input.transaction), mode: window.__fixtureMode });
          return [{ signedTransaction: Uint8Array.from(bytes) }];
        } },
        'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction() { throw Error('Broadcast forbidden'); } },
      } };
    const register = api => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', event => register(event.detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    window.__fixtureChange = () => listeners.forEach(listener => listener({ accounts: [] }));
  }, { address: owner.publicKey.toBase58(), publicKey: Array.from(owner.publicKey.toBytes()), storageDenied });
  await page.goto(server.url);
  await page.waitForFunction(() => document.getElementById('deploymentId').textContent !== '—');
  return { page, calls, expire: () => { expired = true; }, snapshot: () => readDeploymentJournal(journalDirectory),
    async done(label) { report.cases.push(label); await context.close(); context = null; await server.close(); server = null; } };
}
async function ready(h) {
  await h.page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await h.page.waitForFunction(() => document.getElementById('sign').disabled === false);
}
try {
  let h = await open('saved'); await ready(h);
  await h.page.screenshot({ path: path.join(output, 'ready-desktop.png'), fullPage: true });
  await h.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await h.page.screenshot({ path: path.join(output, 'ready-mobile-layout.png'), fullPage: true });
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Подпись сохранена в журнале' }).waitFor();
  assert.equal((await h.snapshot()).revision, 3); assert.equal(signingCalls, 1);
  await h.page.reload(); await h.page.getByRole('status').filter({ hasText: 'Подпись сохранена в журнале' }).waitFor();
  assert.equal(await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).isDisabled(), true);
  assert.equal(signingCalls, 1); await h.done('sign-only, exact journal bytes, desktop/mobile layout and reload');

  h = await open('lost-ack'); await ready(h); let dropped = false;
  await h.page.route('**/api/signature', async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    if (!dropped) { dropped = true; return route.abort(); } return route.fulfill({ response });
  });
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('button', { name: 'Сохранить готовую подпись', exact: true }).waitFor();
  const signedCount = signingCalls;
  await h.page.getByRole('button', { name: 'Сохранить готовую подпись', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Подпись сохранена в журнале' }).waitFor();
  assert.equal(signingCalls, signedCount); assert.equal((await h.snapshot()).revision, 3);
  await h.done('lost acknowledgment recovers without another wallet request or journal event');

  h = await open('preflight'); await ready(h); h.expire(); const before = signingCalls;
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Свежая проверка не пройдена' }).waitFor();
  assert.equal(signingCalls, before); assert.equal((await h.snapshot()).revision, 1);
  await h.done('expired preflight blocks wallet invocation');

  h = await open('wallet-errors'); await h.page.evaluate(() => { window.__fixtureMode = 'wrong'; });
  await h.page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Выберите кошелёк владельца' }).waitFor();
  await h.page.evaluate(() => { window.__fixtureMode = 'cancel'; }); await ready(h);
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Подпись отменена' }).waitFor();
  await h.page.evaluate(() => { window.__fixtureMode = 'unknown'; });
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Повторная подпись заблокирована' }).waitFor();
  await h.page.reload(); await h.page.getByRole('status').filter({ hasText: 'Повторная подпись заблокирована' }).waitFor();
  assert.equal((await h.snapshot()).revision, 4);
  await h.done('wrong owner, explicit cancellation and durable unknown wallet outcome');

  h = await open('changed'); await ready(h); await h.page.evaluate(() => { window.__fixtureMode = 'changed'; });
  await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Повторная подпись заблокирована' }).waitFor();
  assert.equal((await h.snapshot()).revision, 2); await h.done('wallet-changed message is not saved');

  h = await open('storage-denied', { storageDenied: true }); await ready(h);
  const count = signingCalls; await h.page.getByRole('button', { name: 'Проверить и подписать', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Операция не завершена' }).waitFor();
  assert.equal(signingCalls, count); assert.equal((await h.snapshot()).revision, 1);
  await h.done('unavailable IndexedDB blocks wallet before signing');
  assert.deepEqual(report.pageErrors, []); assert.equal(unexpectedExternal, 0); report.passed = true;
} finally {
  await context?.close(); await server?.close(); await browser.close(); policy.owner = originalOwner;
  await rm(parent, { recursive: true, force: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
