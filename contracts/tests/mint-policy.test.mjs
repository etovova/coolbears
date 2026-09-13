import assert from 'node:assert/strict';
import fs from 'node:fs';

const p = JSON.parse(fs.readFileSync('contracts/mint-policy.json', 'utf8'));

function quote(qty) {
  if (!Number.isInteger(qty) || qty < 1 || qty > p.maxPerTransaction) throw new Error('INVALID_QUANTITY');
  return BigInt(qty) * BigInt(p.priceNanoTon);
}

function canMint({ qty, minted, paidNanoTon, paused = false }) {
  if (paused) return { ok: false, code: 'MINT_PAUSED' };
  if (!Number.isInteger(qty) || qty < 1 || qty > p.maxPerTransaction) return { ok: false, code: 'INVALID_QUANTITY' };
  if (minted + qty > p.supply) return { ok: false, code: 'SOLD_OUT' };
  if (BigInt(paidNanoTon) < quote(qty)) return { ok: false, code: 'UNDERPAID' };
  return { ok: true, firstIndex: minted, nextIndex: minted + qty, requiredNanoTon: quote(qty) };
}

assert.equal(quote(1), 7_000_000_000n);
assert.equal(quote(50), 350_000_000_000n);
assert.throws(() => quote(0), /INVALID_QUANTITY/);
assert.throws(() => quote(51), /INVALID_QUANTITY/);
assert.deepEqual(canMint({ qty: 1, minted: 0, paidNanoTon: 6_999_999_999n }), { ok: false, code: 'UNDERPAID' });
assert.equal(canMint({ qty: 1, minted: 0, paidNanoTon: 7_000_000_000n }).ok, true);
assert.equal(canMint({ qty: 50, minted: 9950, paidNanoTon: 350_000_000_000n }).nextIndex, 10000);
assert.deepEqual(canMint({ qty: 1, minted: 10000, paidNanoTon: 7_000_000_000n }), { ok: false, code: 'SOLD_OUT' });
assert.deepEqual(canMint({ qty: 51, minted: 0, paidNanoTon: 357_000_000_000n }), { ok: false, code: 'INVALID_QUANTITY' });
assert.deepEqual(canMint({ qty: 1, minted: 0, paidNanoTon: 7_000_000_000n, paused: true }), { ok: false, code: 'MINT_PAUSED' });

// Sequential index invariant: accepted mints consume exactly qty indexes and never overlap.
let next = 0;
for (const qty of [1, 2, 50, 7, 40]) {
  const r = canMint({ qty, minted: next, paidNanoTon: quote(qty) });
  assert.equal(r.ok, true);
  assert.equal(r.firstIndex, next);
  assert.equal(r.nextIndex - r.firstIndex, qty);
  next = r.nextIndex;
}

console.log('CoolBears mint policy model tests: OK');
