import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readPassphrase, samePassphrase } from '../deployment/passphrase.mjs';

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
const phrase = () => Buffer.from('temporary TEST passphrase only');
const safe = error => { assert.match(error.code, /^DEPLOYMENT_PASSPHRASE_/); assert.ok(!String(error).includes('temporary')); return true; };
function restored(input) {
  assert.equal(input.isRaw, false); assert.equal(input.readableFlowing, false);
  assert.deepEqual(input.rawModes, [true, false]);
  for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0);
}

test('terminal passphrase returns bytes without echo and wipes consumed input chunks', async () => {
  for (const ending of ['\r', '\n', '\r\n']) {
    const input = new Input(), output = new Output(), expected = phrase();
    const chunk = Buffer.concat([expected, Buffer.from(ending)]);
    const pending = readPassphrase({ input, output });
    assert.equal(input.isRaw, true);
    input.emit('data', chunk);
    const result = await pending;
    assert.ok(result instanceof Uint8Array); assert.deepEqual(Buffer.from(result), expected);
    assert.ok(chunk.every(byte => byte === 0));
    assert.equal(output.text, 'Passphrase (hidden): \n');
    restored(input); result.fill(0); expected.fill(0);
  }
});

test('fresh stdin with readableFlowing null is paused after input so a CLI can exit', async () => {
  const input = new Input(), output = new Output();
  assert.equal(input.readableFlowing, null);
  const pending = readPassphrase({ input, output, confirmation: true });
  input.emit('data', Buffer.concat([phrase(), Buffer.from('\r')]));
  (await pending).fill(0);
  assert.equal(input.readableFlowing, false);
  assert.equal(output.text, 'Repeat passphrase (hidden): \n');
});

test('already raw and flowing input retains its prior terminal state', async () => {
  const input = new Input(), output = new Output();
  input.isRaw = true; input.readableFlowing = true;
  const pending = readPassphrase({ input, output });
  input.emit('data', Buffer.concat([phrase(), Buffer.from('\r')]));
  (await pending).fill(0);
  assert.equal(input.isRaw, true); assert.equal(input.readableFlowing, true);
  assert.deepEqual(input.rawModes, [true, true]);
});

test('UTF-8 passphrases and backspace work on whole characters without string secrets', async () => {
  const input = new Input(), output = new Output();
  const expected = Buffer.from('пароль для теста');
  const pending = readPassphrase({ input, output });
  input.emit('data', Buffer.concat([expected, Buffer.from('🐻'), Buffer.from([127, 13])]));
  const result = await pending;
  assert.deepEqual(Buffer.from(result), expected); result.fill(0); expected.fill(0);
  restored(input);
});

test('nonterminal, encoded, buffered or already observed input is refused before prompting', async () => {
  for (const mutate of [
    (input, _output) => { input.isTTY = false; },
    (_input, output) => { output.isTTY = false; },
    input => { input.readableEncoding = 'utf8'; },
    input => { input.readableLength = 1; },
    input => { input.on('data', () => {}); },
  ]) {
    const input = new Input(), output = new Output(); mutate(input, output);
    await assert.rejects(readPassphrase({ input, output }), safe);
    assert.deepEqual(input.rawModes, []); assert.equal(output.text, '');
  }
});

test('short, oversized, malformed, control and multiline input fail closed and restore terminal', async () => {
  for (const chunk of [
    Buffer.from('too short\r'), Buffer.alloc(1025, 65),
    Buffer.concat([phrase(), Buffer.from([0, 13])]),
    Buffer.concat([phrase(), Buffer.from([9, 13])]),
    Buffer.concat([phrase(), Buffer.from([27, 91, 65, 13])]),
    Buffer.concat([phrase(), Buffer.from([0xff, 13])]),
    Buffer.concat([phrase(), Buffer.from('\u2028\r')]),
    Buffer.concat([phrase(), Buffer.from('\rsecond pasted line\r')]),
  ]) {
    const input = new Input(), output = new Output();
    const pending = readPassphrase({ input, output }); input.emit('data', chunk);
    await assert.rejects(pending, safe);
    assert.ok(chunk.every(byte => byte === 0)); assert.ok(!output.text.includes('temporary')); restored(input);
  }
  const input = new Input(), output = new Output();
  const pending = readPassphrase({ input, output }); input.emit('data', 'immutable string input');
  await assert.rejects(pending, safe); restored(input);
});

test('a multiline paste split into data events cannot become a confirmation', async () => {
  const input = new Input(), output = new Output();
  const pending = readPassphrase({ input, output });
  input.emit('data', Buffer.concat([phrase(), Buffer.from('\r')]));
  input.emit('data', Buffer.from('extra secret pasted\r'));
  await assert.rejects(pending, safe); restored(input);
});

test('Ctrl-C, Ctrl-D, EOF and stream errors restore raw mode and release listeners', async () => {
  for (const event of ['ctrl-c', 'ctrl-d', 'end', 'close', 'error', 'output-error']) {
    const input = new Input(), output = new Output();
    const pending = readPassphrase({ input, output });
    input.emit('data', phrase());
    if (event.startsWith('ctrl-')) input.emit('data', Buffer.from([event === 'ctrl-c' ? 3 : 4]));
    else if (event === 'output-error') output.emit('error', Error('secret terminal error'));
    else input.emit(event, Error('secret terminal error'));
    await assert.rejects(pending, error => safe(error) && !String(error).includes('secret terminal error'));
    restored(input); assert.equal(output.listenerCount('error'), 0);
  }
});

test('a terminal setup failure still restores prior mode and releases input', async () => {
  const input = new Input(), output = new Output();
  input.setRawMode = value => { input.rawModes.push(value); if (value) throw Error('secret native error'); input.isRaw = value; };
  await assert.rejects(readPassphrase({ input, output }), safe);
  restored(input);
});

test('passphrase comparison handles full byte range and preserves caller-owned buffers', () => {
  const first = phrase(), second = Buffer.from(first), different = Buffer.from(first);
  different[0] ^= 1;
  assert.equal(samePassphrase(first, second), true); assert.equal(samePassphrase(first, different), false);
  assert.equal(samePassphrase(first, Buffer.concat([second, Buffer.from('!')])), false);
  assert.deepEqual(first, second);
  assert.equal(samePassphrase(Buffer.alloc(1024, 65), Buffer.alloc(1024, 65)), true);
  for (const input of ['string passphrase', Buffer.alloc(15), Buffer.alloc(1025)]) assert.throws(() => samePassphrase(input, second), safe);
  first.fill(0); second.fill(0); different.fill(0);
});
