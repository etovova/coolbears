// Local terminal bytes only. No environment, argument, file, readline echo or
// immutable JavaScript passphrase string is used by this helper.
import { timingSafeEqual } from 'node:crypto';

const MIN = 16, MAX = 1024;
const failure = code => Object.assign(new Error(code === 'CANCELLED'
  ? 'Passphrase entry was cancelled.' : code === 'TTY'
    ? 'Passphrase entry requires an exclusive local terminal.' : 'Passphrase entry was invalid.'),
{ code: `DEPLOYMENT_PASSPHRASE_${code}` });

function validUtf8(bytes) {
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]; let point, count, minimum;
    if (first < 128) { if (first < 32 || first === 127) return false; continue; }
    if (first >= 0xc2 && first <= 0xdf) { point = first & 31; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { point = first & 15; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { point = first & 7; count = 3; minimum = 0x10000; }
    else return false;
    for (let offset = 0; offset < count; offset++) {
      const next = bytes[index++];
      if (next === undefined || (next & 0xc0) !== 0x80) return false;
      point = (point << 6) | (next & 63);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      || point < 0xa0 || point === 0x2028 || point === 0x2029) return false;
  }
  return true;
}

export function samePassphrase(first, second) {
  if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array)
    || first.length < MIN || first.length > MAX || second.length < MIN || second.length > MAX) throw failure('INVALID');
  const left = Buffer.alloc(MAX), right = Buffer.alloc(MAX);
  try {
    left.set(first); right.set(second);
    const equal = timingSafeEqual(left, right);
    return equal && first.length === second.length;
  } finally { left.fill(0); right.fill(0); }
}

export async function readPassphrase({ input = process.stdin, output = process.stderr, confirmation = false } = {}) {
  if (input?.isTTY !== true || output?.isTTY !== true || typeof input.setRawMode !== 'function'
    || typeof input.on !== 'function' || typeof input.removeListener !== 'function'
    || typeof input.pause !== 'function' || typeof input.resume !== 'function'
    || typeof output.on !== 'function' || typeof output.removeListener !== 'function' || typeof output.write !== 'function'
    || input.readableEncoding || input.listenerCount?.('data') > 0 || input.readableLength > 0) throw failure('TTY');
  const storage = Buffer.alloc(MAX);
  let size = 0, finished = false, entered = false, endedWithCr = false, immediate;
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  return new Promise((resolve, reject) => {
    function finish(error) {
      if (finished) return;
      finished = true; clearImmediate(immediate);
      input.removeListener('data', onData); input.removeListener('error', onError);
      input.removeListener('end', onEnd); input.removeListener('close', onEnd);
      output.removeListener('error', onError); output.removeListener('close', onEnd);
      let result;
      if (!error) result = Uint8Array.from(storage.subarray(0, size));
      storage.fill(0); size = 0;
      try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); }
      catch { error = failure('TTY'); }
      try { output.write('\n'); } catch { error = failure('TTY'); }
      if (error) { result?.fill(0); reject(error); } else resolve(result);
    }
    function onError() { finish(failure('TTY')); }
    function onEnd() { finish(failure('CANCELLED')); }
    function onData(chunk) {
      try {
        if (!(chunk instanceof Uint8Array)) return finish(failure('INVALID'));
        if (entered) {
          // A CRLF pair may arrive in separate chunks. Any other trailing
          // input is multiline paste and must not become a second password.
          if (endedWithCr && chunk.length === 1 && chunk[0] === 10) { endedWithCr = false; return; }
          return finish(failure('INVALID'));
        }
        for (let index = 0; index < chunk.length; index++) {
          const byte = chunk[index];
          if (byte === 3 || byte === 4) return finish(failure('CANCELLED'));
          if (byte === 13 || byte === 10) {
            if (index !== chunk.length - 1 && !(byte === 13 && index === chunk.length - 2 && chunk[index + 1] === 10)) return finish(failure('INVALID'));
            if (size < MIN || !validUtf8(storage.subarray(0, size))) return finish(failure('INVALID'));
            entered = true; endedWithCr = byte === 13 && index === chunk.length - 1;
            // Keep raw mode through this event-loop turn to reject buffered
            // trailing paste before restoring the terminal's normal echo.
            immediate = setImmediate(() => finish());
            return;
          }
          if (byte === 8 || byte === 127) {
            let removed;
            do { if (!size) break; removed = storage[--size]; storage[size] = 0; }
            while (size && (removed & 0xc0) === 0x80);
            continue;
          }
          if (byte < 32 || size === MAX) return finish(failure('INVALID'));
          storage[size++] = byte;
        }
      } catch { finish(failure('INVALID')); }
      finally { if (chunk instanceof Uint8Array) chunk.fill(0); }
    }
    try {
      input.on('data', onData); input.on('error', onError); input.on('end', onEnd); input.on('close', onEnd);
      output.on('error', onError); output.on('close', onEnd);
      input.setRawMode(true);
      output.write(confirmation ? 'Repeat passphrase (hidden): ' : 'Passphrase (hidden): ');
      input.resume();
    } catch { finish(failure('TTY')); }
  });
}
