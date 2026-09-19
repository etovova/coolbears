import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const owner = 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y';
const backup = { owner, cluster: 'devnet', assets: [owner], transactions: ['saved-signature'], pending: { signature: 'pending-signature', lastValidBlockHeight: 100 } };
async function setup(clipboard) {
  const elements = new Map(), writes = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: true, focus() {}, select() { this.selected = true; }, setSelectionRange() {} });
    return elements.get(id);
  };
  const scope = { document: { getElementById: get }, navigator: { clipboard }, TextEncoder,
    localStorage: { getItem: () => JSON.stringify(backup), setItem: (_, value) => writes.push(value) },
    createWalletUI: () => ({ address: '' }) };
  const source = (await readFile('solana-test/controller.mjs', 'utf8')).replace(/^import .*\n/, '');
  runInNewContext(source, scope);
  return { get, writes, scope };
}
test('Copy keeps complete recovery state, including pending signatures, without file download', async () => {
  let copied;
  const { get } = await setup({ writeText: async text => { copied = text; } });
  await get('copyBackup').onclick();
  assert.deepEqual(JSON.parse(copied), backup);
  assert.equal(get('backupPanel').hidden, false);
  assert.match(get('backupStatus').textContent, /скопирован/);
});
test('Clipboard denial leaves visible selectable text and manual instructions', async () => {
  const { get } = await setup({ writeText: async () => { throw Error('Denied'); } });
  await get('copyBackup').onclick();
  assert.deepEqual(JSON.parse(get('backupText').value), backup);
  assert.equal(get('backupText').selected, true);
  assert.match(get('backupStatus').textContent, /Выделить всё/);
});
test('Text restore validates input and cannot overwrite an unresolved transaction', async () => {
  const { get, writes, scope } = await setup();
  get('restoreText').value = JSON.stringify({ ...backup, cluster: 'mainnet-beta' });
  await get('restoreTextButton').onclick(); assert.equal(writes.length, 0);
  get('restoreText').value = JSON.stringify(backup);
  await get('restoreTextButton').onclick(); assert.equal(writes.length, 0);
  assert.match(get('status').textContent, /предыдущая операция/);
  runInNewContext('state = {}', scope);
  await get('restoreTextButton').onclick();
  assert.deepEqual(JSON.parse(writes[0]), backup);
});
