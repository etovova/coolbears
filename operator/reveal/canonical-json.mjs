// Same serialization in Node, browser and Workers; no file, network or secrets.
const encoder = new TextEncoder();
class CanonicalError extends Error {
  constructor(code = 'INVALID') { super('Reveal JSON could not be serialized.'); this.code = `REVEAL_${code}`; }
}
const check = (condition, code) => { if (!condition) throw new CanonicalError(code); };
export function canonicalRevealValue(value, depth = 0) {
  check(depth <= 24, 'SIZE');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { check(encoder.encode(value).length <= 32768, 'SIZE'); return JSON.stringify(value); }
  if (typeof value === 'number') { check(Number.isFinite(value) && !Object.is(value, -0)); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    check(Object.getPrototypeOf(value) === Array.prototype);
    check(value.length <= 10000 && Object.keys(value).length === value.length
      && Reflect.ownKeys(value).length === value.length + 1, 'SIZE');
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      items.push(canonicalRevealValue(descriptor.value, depth + 1));
    }
    return '[' + items.join(',') + ']';
  }
  check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  check(keys.every(key => typeof key === 'string'));
  keys.sort();
  return '{' + keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    return JSON.stringify(key) + ':' + canonicalRevealValue(descriptor.value, depth + 1);
  }).join(',') + '}';
}
export function canonicalRevealJson(value) { return canonicalRevealValue(value) + '\n'; }
