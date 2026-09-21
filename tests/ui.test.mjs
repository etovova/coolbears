import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { SPEC } from '../chain/spec.mjs';

function page(html, url) {
  const window = new Window({ url, settings: { disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, enableJavaScriptEvaluation: true } });
  window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  return window;
}
test('main page: closed mint, quantity bounds, translations and wallet controls', async () => {
  const w = page(await readFile('index.html','utf8'), 'https://coolbears-nfts.com/');
  w.eval(await readFile('config.js','utf8')); w.eval(await readFile('app.js','utf8'));
  const qty = w.document.querySelector('#qty'), total = w.document.querySelector('#total');
  assert(w.document.querySelector('#mintBtn').disabled);
  for (const [input, expected] of [['1000','50'], ['-7','1'], ['abc','1'], ['3','3']]) {
    qty.value = input; qty.dispatchEvent(new w.Event('input')); assert.equal(qty.value, expected);
  }
  assert.equal(total.textContent, '1.5');
  for (const language of ['ru','zh','en']) {
    w.document.querySelector(`[data-lang="${language}"]`).click();
    assert.equal(w.document.documentElement.lang, language === 'zh' ? 'zh-CN' : language);
    assert(w.document.querySelector('#mintBtn').disabled);
    assert(w.document.querySelector('#walletBtn').textContent.length > 0);
  }
  await w.happyDOM.close();
});
test('owner panel: SDK bundle loads in a browser-like DOM and wrong owner cannot create', async () => {
  const w = page(await readFile('manage/index.html','utf8'), 'https://coolbears-nfts.com/manage/');
  let signatures = 0;
  w.phantom = { solana: { isPhantom: true, publicKey: { toString: () => '11111111111111111111111111111111' },
    connect: async () => ({ publicKey: { toString: () => '11111111111111111111111111111111' } }),
    signAndSendTransaction: async () => { signatures++; }, on() {}, removeListener() {} } };
  w.fetch = async () => new w.Response(JSON.stringify({ verified: true, commitment: 'ab'.repeat(32) }), { status: 200, headers: { 'Content-Type':'application/json' } });
  const bundled = await build({ entryPoints: ['manage/manage.mjs'], bundle: true, platform: 'browser', format: 'esm', write: false, target: 'es2022',
    define: { 'import.meta.url': JSON.stringify('https://coolbears-nfts.com/wallet-ui.mjs') } });
  w.eval(`(async()=>{${bundled.outputFiles[0].text}\n})()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(w.document.querySelector('#releaseStatus').textContent,/10 000/);
  assert(w.document.querySelector('#create').disabled);
  w.document.querySelector('#connect').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const phantom = [...w.document.querySelectorAll('dialog button')].find(b => b.textContent === 'Phantom');
  assert(phantom, 'Injected wallet is selectable'); phantom.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(w.document.querySelector('#create').disabled);
  assert.match(w.document.querySelector('#status').textContent,/владельца/);
  assert.equal(signatures, 0);
  assert.notEqual(w.document.querySelector('#wallet').textContent, SPEC.owner);
  await w.happyDOM.close();
});
