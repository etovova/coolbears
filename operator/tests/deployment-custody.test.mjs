import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCustody } from '../deployment/custody.mjs';

const OPTIONS = Object.freeze({ id: 'custody-offline-test', cluster: 'devnet',
  blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000,
  machineRentLamports: '5000000000' });
const TEST_PHRASE = 'temporary TEST passphrase only';
class Input extends EventEmitter {
  isTTY = true; isRaw = false; readableEncoding = null; readableLength = 0; readableFlowing = null;
  rawModes = [];
  setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
  resume() { this.readableFlowing = true; }
  pause() { this.readableFlowing = false; }
}
class Output extends EventEmitter {
  isTTY = true; text = '';
  write(text) { this.text += text; return true; }
}
function terminal(answers = []) {
  const input = new Input(), output = new Output(), errorOutput = new Output(), consumed = [];
  output.isTTY = false; // The public JSON report may safely be redirected.
  let prompts = 0;
  errorOutput.write = text => {
    errorOutput.text += text;
    if (text === 'Passphrase (hidden): ' || text === 'Repeat passphrase (hidden): ') {
      assert.ok(prompts < answers.length, 'Unexpected secret prompt');
      const answer = answers[prompts++];
      const bytes = Buffer.isBuffer(answer) ? Buffer.from(answer) : Buffer.from(answer + '\r');
      consumed.push(bytes);
      setImmediate(() => input.emit('data', bytes));
    }
    return true;
  };
  return { input, output, errorOutput, consumed, get prompts() { return prompts; } };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'coolbears-custody-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function restored(io, expectedPrompts) {
  assert.equal(io.prompts, expectedPrompts);
  assert.equal(io.input.isRaw, false); assert.equal(io.input.readableFlowing, false);
  assert.deepEqual(io.input.rawModes, Array.from({ length: expectedPrompts }, () => [true, false]).flat());
  assert.ok(io.consumed.every(bytes => bytes.every(byte => byte === 0)));
  for (const event of ['data', 'error', 'end', 'close']) assert.equal(io.input.listenerCount(event), 0);
}
function errorReport(io, code) {
  assert.equal(io.output.text, '');
  const line = io.errorOutput.text.trim().split('\n').at(-1);
  const report = JSON.parse(line);
  assert.equal(report.ok, false); assert.equal(report.code, `DEPLOYMENT_CUSTODY_${code}`);
  assert.ok(!io.errorOutput.text.includes(TEST_PHRASE));
  assert.ok(!io.errorOutput.text.includes('private path sentinel'));
  return report;
}

test('offline init, inspect and verify use one ephemeral encrypted bundle without signing or network', { timeout: 120000 }, async t => {
  const root = await temporary(t), directory = path.join(root, 'bundle'), optionsFile = path.join(root, 'public.json');
  await writeFile(optionsFile, JSON.stringify(OPTIONS));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw Error('Unexpected network access'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const init = terminal([TEST_PHRASE, TEST_PHRASE]);
  assert.equal(await runCustody(['init', directory, optionsFile], init), 0);
  restored(init, 2);
  assert.equal(init.errorOutput.text, 'Passphrase (hidden): \nRepeat passphrase (hidden): \n');
  const report = JSON.parse(init.output.text);
  assert.deepEqual(Object.keys(report).sort(), ['ok', 'command', 'mode', 'id', 'cluster', 'owner', 'roles',
    'manifestSha256', 'journalRevision', 'journalHead', 'action', 'readyToSubmit', 'salesOpen',
    'networkRequests', 'signaturesCreated', 'transactionsSent'].sort());
  assert.equal(report.ok, true); assert.equal(report.command, 'init'); assert.equal(report.mode, 'offline-custody');
  assert.equal(report.id, OPTIONS.id); assert.equal(report.cluster, OPTIONS.cluster);
  assert.equal(report.readyToSubmit, false); assert.equal(report.salesOpen, false);
  assert.equal(report.networkRequests, 0); assert.equal(report.signaturesCreated, 0); assert.equal(report.transactionsSent, 0);
  assert.equal(report.journalRevision, 0); assert.match(report.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(report.roles).sort(), ['collection', 'reservedAsset', 'machine', 'guard',
    'collectionUpdateAuthority', 'reservedAssetOwner', 'candyMachineAuthority', 'candyGuardAuthority'].sort());
  assert.equal(new Set([report.roles.collection, report.roles.reservedAsset, report.roles.machine]).size, 3);
  for (const role of ['collectionUpdateAuthority', 'reservedAssetOwner', 'candyMachineAuthority', 'candyGuardAuthority']) {
    assert.equal(report.roles[role], report.owner);
  }

  const files = ['vault.json', 'READY.json', 'journal/manifest.json'];
  const before = await Promise.all(files.map(file => readFile(path.join(directory, file))));
  const vault = JSON.parse(before[0]);
  assert.ok(!init.output.text.includes(TEST_PHRASE));
  for (const field of ['ciphertextBase64', 'saltBase64', 'ivBase64', 'tagBase64']) {
    assert.equal(typeof vault[field], 'string');
    assert.ok(!init.output.text.includes(vault[field]));
  }
  const inspect = terminal(); inspect.input.isTTY = false; inspect.errorOutput.isTTY = false;
  assert.equal(await runCustody(['inspect', directory], inspect), 0);
  assert.equal(inspect.prompts, 0); assert.equal(inspect.errorOutput.text, '');
  assert.deepEqual(JSON.parse(inspect.output.text), { ...report, command: 'inspect' });

  const verify = terminal([TEST_PHRASE]);
  assert.equal(await runCustody(['verify', directory], verify), 0);
  restored(verify, 1);
  assert.deepEqual(JSON.parse(verify.output.text), { ...report, command: 'verify', localKeysVerified: true });
  const wrong = terminal(['a different temporary TEST phrase']);
  assert.equal(await runCustody(['verify', directory], wrong), 1);
  restored(wrong, 1); errorReport(wrong, 'VERIFY');
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(directory, file)))), before);
  assert.deepEqual(await readdir(path.join(directory, 'journal/events')), []);
  assert.equal(networkCalls, 0);
});

test('CLI arguments never accept or echo secret arguments and do not prompt', async () => {
  for (const args of [[], ['unknown'], ['inspect'], ['verify', 'path', TEST_PHRASE],
    ['init', 'path', 'options', '--passphrase', TEST_PHRASE], ['inspect', '--secret=' + TEST_PHRASE],
    ['inspect', ''], ['inspect', 'a'.repeat(4097)], ['inspect', 1], null]) {
    const io = terminal();
    assert.equal(await runCustody(args, io), 1); errorReport(io, 'ARGUMENTS');
    assert.equal(io.prompts, 0); assert.deepEqual(io.input.rawModes, []);
  }
});

test('public options enforce exact fields, types, values, valid UTF-8 and 4096-byte bound before any prompt', async t => {
  const root = await temporary(t), optionsFile = path.join(root, 'public.json'), directory = path.join(root, 'never-created');
  const invalid = [
    { ...OPTIONS, passphrase: TEST_PHRASE }, { ...OPTIONS, id: '../private path sentinel' },
    { ...OPTIONS, cluster: 'testnet' }, { ...OPTIONS, blockhash: 'invalid' },
    { ...OPTIONS, lastValidBlockHeight: 0 }, { ...OPTIONS, lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 },
    { ...OPTIONS, machineRentLamports: 5000000000 }, { ...OPTIONS, machineRentLamports: '0' },
    { ...OPTIONS, machineRentLamports: '18446744073709551616' },
    { id: OPTIONS.id }, [], null,
  ].map(value => Buffer.from(JSON.stringify(value)));
  invalid.push(Buffer.from('{invalid private path sentinel'), Buffer.alloc(4097, 32), Buffer.from([0xff]));
  for (const bytes of invalid) {
    await writeFile(optionsFile, bytes);
    const io = terminal();
    assert.equal(await runCustody(['init', directory, optionsFile], io), 1);
    errorReport(io, 'OPTIONS'); assert.equal(io.prompts, 0);
  }
  assert.deepEqual((await readdir(root)).sort(), ['public.json']);
});

test('public options reject symlinks, directories and missing files without echoing paths', async t => {
  const root = await temporary(t), optionsFile = path.join(root, 'public.json'), link = path.join(root, 'options-link');
  await writeFile(optionsFile, JSON.stringify(OPTIONS)); await symlink(optionsFile, link);
  for (const filename of [link, root, path.join(root, 'private path sentinel')]) {
    const io = terminal();
    assert.equal(await runCustody(['init', path.join(root, 'never-created'), filename], io), 1);
    errorReport(io, 'OPTIONS'); assert.equal(io.prompts, 0);
  }
});

test('confirmation mismatch and cancellation restore terminal and never create a bundle', async t => {
  const root = await temporary(t), optionsFile = path.join(root, 'public.json'), directory = path.join(root, 'never-created');
  await writeFile(optionsFile, JSON.stringify(OPTIONS));
  for (const answers of [[TEST_PHRASE, TEST_PHRASE + '!'], [Buffer.from([3])], [Buffer.from([4])]]) {
    const io = terminal(answers);
    assert.equal(await runCustody(['init', directory, optionsFile], io), 1);
    errorReport(io, 'PASSPHRASE'); restored(io, answers.length);
  }
  assert.deepEqual(await readdir(root), ['public.json']);
});

test('non-TTY init and missing bundle inspect fail closed without a secret prompt', async t => {
  const root = await temporary(t), optionsFile = path.join(root, 'public.json'), directory = path.join(root, 'private path sentinel');
  await writeFile(optionsFile, JSON.stringify(OPTIONS));
  const init = terminal(); init.input.isTTY = false;
  assert.equal(await runCustody(['init', directory, optionsFile], init), 1);
  errorReport(init, 'PASSPHRASE'); assert.equal(init.prompts, 0);
  const inspect = terminal();
  assert.equal(await runCustody(['inspect', directory], inspect), 1);
  errorReport(inspect, 'INSPECT'); assert.equal(inspect.prompts, 0);
  assert.deepEqual(await readdir(root), ['public.json']);
});
