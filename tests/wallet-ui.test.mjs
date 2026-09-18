import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletUI } from '../wallet-ui.mjs';

// Small event-driven DOM fixture: run the actual chooser without a wallet app.
class Element extends EventTarget {
  children = [];
  dataset = {};
  constructor(tagName) { super(); this.tagName = tagName; }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  remove() { this.removed = true; }
}

test('Mobile chooser shows both wallets, waits for selection and can be cancelled and reopened', async t => {
  let calls = 0;
  const phantom = { isPhantom: true, connect: async () => { calls++; return { publicKey: 'PhantomTestAddress' }; } };
  const body = new Element('body');
  const globals = {
    document: { head: new Element('head'), body, querySelector: () => null, createElement: tag => new Element(tag) },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux', maxTouchPoints: 1 },
    location: { href: 'https://coolbears-nfts.com/solana-test/' },
    window: { phantom: { solana: phantom } }
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const ui = createWalletUI({ language: () => 'ru' });
  const pending = ui.connect();
  let dialog = body.children.at(-1);
  assert.equal(dialog.open, true);
  assert.equal(calls, 0, 'a single detected wallet must not connect automatically');
  assert.equal(dialog.children.find(item => item.tagName === 'button').textContent, 'Phantom');
  const solflare = dialog.children.find(item => item.tagName === 'a');
  assert.equal(solflare.textContent, 'Открыть в Solflare');
  assert.ok(solflare.href.startsWith('https://solflare.com/ul/v1/browse/'));
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  dialog.close();
  await cancelled;
  assert.equal(ui.address, '');
  assert.equal(calls, 0);
  assert.equal(dialog.removed, true);

  const connection = ui.connect();
  dialog = body.children.at(-1);
  dialog.children.find(item => item.tagName === 'button' && item.textContent === 'Phantom').onclick();
  assert.equal(await connection, 'PhantomTestAddress');
  assert.equal(calls, 1);
  assert.equal(ui.provider, phantom);
  assert.equal(dialog.removed, true);
});
