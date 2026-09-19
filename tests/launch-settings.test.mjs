import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Approved price updates quantities and languages while mint stays closed', async () => {
  const element = (extra = {}) => ({
    textContent: '', value: '1', dataset: {}, events: {},
    classList: { toggle() {} }, setAttribute() {},
    addEventListener(name, fn) { this.events[name] = fn; }, ...extra
  });
  const elements = Object.fromEntries(['qty', 'total', 'unitPrice', 'mintBtn', 'minted', 'minus', 'plus'].map(id => [id, element()]));
  const walletWrites = [];
  elements.walletBtn = new Proxy(element(), {
    set(target, property, value) {
      walletWrites.push(property);
      target[property] = value;
      return true;
    }
  });
  const languages = ['en', 'ru', 'zh'].map(lang => element({ dataset: { lang } }));
  const scope = {
    window: {},
    localStorage: { getItem: () => 'en', setItem() {} },
    document: {
      addEventListener() {}, documentElement: {}, body: { append() {} },
      createElement: () => element(),
      querySelector: selector => elements[selector.slice(1)] || null,
      querySelectorAll: selector => selector === '.bear-lang' ? languages : []
    }
  };
  runInNewContext(await readFile('config.js', 'utf8'), scope);
  const cfg = scope.window.COOLBEARS_CONFIG;
  assert.equal(cfg.priceSol * 1e9, 500000000);
  assert.equal(cfg.ownerAddress, 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y');
  assert.equal(cfg.demoMode, true);
  assert.equal(cfg.candyMachineAddress, '');
  assert.equal(cfg.cluster, 'devnet');
  runInNewContext(await readFile('app.js', 'utf8'), scope);
  assert.equal(elements.unitPrice.textContent, '0.5 SOL');
  assert.equal(elements.total.textContent, '0.5');
  assert.equal(elements.mintBtn.disabled, true);

  // Updating quantity must not rewrite the sticky header's wallet control.
  walletWrites.length = 0;
  for (let i = 0; i < 9; i++) elements.plus.events.click();
  assert.equal(Number(elements.qty.value), 10);
  assert.equal(elements.total.textContent, '5');
  elements.minus.events.click();
  assert.equal(Number(elements.qty.value), 9);
  assert.equal(elements.total.textContent, '4.5');
  elements.qty.value = '1';
  elements.qty.events.input();
  assert.deepEqual(walletWrites, [], 'plus, minus and typed quantities must not redraw the wallet');

  languages[1].events.click();
  assert.equal(elements.unitPrice.textContent, '0,5 SOL');
  assert.equal(elements.total.textContent, '0,5');
  elements.qty.value = '3';
  elements.qty.events.input();
  assert.equal(elements.total.textContent, '1,5');
  languages[2].events.click();
  assert.equal(elements.unitPrice.textContent, '0.5 SOL');
  assert.equal(elements.total.textContent, '1.5');
  elements.qty.value = '100';
  elements.qty.events.input();
  assert.equal(Number(elements.qty.value), 50);
  assert.equal(elements.total.textContent, '25');
  elements.qty.value = '-1';
  elements.qty.events.input();
  assert.equal(Number(elements.qty.value), 1);
  assert.equal(elements.total.textContent, '0.5');
  assert.equal(elements.mintBtn.disabled, true);
});
