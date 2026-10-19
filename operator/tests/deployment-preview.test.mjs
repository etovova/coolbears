// Synthetic RPC only. Live public Devnet work is an explicitly separate CI job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { quotePreviewFeeWindows } from '../deployment/preview-fees.mjs';
import { previewDevnetDeployment } from '../deployment/preview.mjs';

const address = n => new PublicKey(new Uint8Array(32).fill(n));
function makePlan(count = 5) {
  return { steps: Array.from({ length: count }, (_, index) => {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: address(1),
      recentBlockhash: address(2).toBase58(), instructions: [SystemProgram.transfer({
        fromPubkey: address(1), toPubkey: address(3 + index), lamports: index + 1,
      })] }).compileToV0Message());
    return { id: 'step-' + index, transactionBase64: Buffer.from(tx.serialize()).toString('base64') };
  }) };
}
function fixture(override = {}) {
  const calls = [], observedFees = [];
  let block = 50;
  return { calls, observedFees, async call(method, params) {
    calls.push({ method, params });
    const slot = 100 + calls.length;
    if (Object.hasOwn(override, method)) return override[method]({ method, params, slot, calls });
    if (method === 'getLatestBlockhash') return { context: { slot }, value: { blockhash: address(block++).toBase58(), lastValidBlockHeight: 2000 } };
    if (method === 'getFeeForMessage') {
      const fee = 5000 + calls.length; observedFees.push(fee);
      return { context: { slot }, value: fee };
    }
    if (method === 'isBlockhashValid') return { context: { slot }, value: true };
    if (method === 'getBlockHeight') return 1500;
    throw Error('Unexpected network capability: ' + method);
  } };
}

test('each message including the last partial window is quoted, and source bytes are preserved', async () => {
  const plan = makePlan(), original = JSON.stringify(plan), rpc = fixture(), progress = [];
  const result = await quotePreviewFeeWindows({ plan, rpc, minimumSlot: 99, windowSize: 2, onProgress: p => progress.push(p) });
  assert.equal(JSON.stringify(plan), original);
  assert.equal(result.steps.length, 5);
  assert.deepEqual(result.windows.map(w => w.count), [2, 2, 1]);
  assert.deepEqual(progress.map(p => p.quotedMessages), [2, 4, 5]);
  assert.equal(result.networkFeesLamports, rpc.observedFees.reduce((a, b) => a + BigInt(b), 0n).toString());
  assert.equal(new Set(result.steps.map(s => s.messageSha256)).size, 5);
  assert.equal(result.everyMessageQuoted, true);
  assert.equal(result.allQuotesSimultaneouslyFresh, false);
  assert.equal(result.signable, false);
  const latest = rpc.calls.filter(c => c.method === 'getLatestBlockhash');
  assert.equal(latest[1].params[0].minContextSlot, result.windows[0].checkedSlot);
  assert.equal(latest[2].params[0].minContextSlot, result.windows[1].checkedSlot);
  assert.ok(rpc.calls.every(c => !/send|airdrop|simulate/i.test(c.method)));
});

test('fee totals retain integer precision above Number.MAX_SAFE_INTEGER', async () => {
  const rpc = fixture({ getFeeForMessage: ({ slot }) => ({ context: { slot }, value: Number.MAX_SAFE_INTEGER }) });
  const result = await quotePreviewFeeWindows({ plan: makePlan(2), rpc });
  assert.equal(result.networkFeesLamports, (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
});

for (const [name, override, code] of [
  ['null fee', { getFeeForMessage: ({ slot }) => ({ context: { slot }, value: null }) }, 'FEE_QUOTE_UNAVAILABLE'],
  ['old quote slot', { getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }) }, 'INVALID_RPC_CONTEXT'],
  ['zero fee', { getFeeForMessage: ({ slot }) => ({ context: { slot }, value: 0 }) }, 'INVALID_FEE_QUOTE'],
  ['expired hash', { isBlockhashValid: ({ slot }) => ({ context: { slot }, value: false }) }, 'PREVIEW_WINDOW_BLOCKHASH_EXPIRED'],
  ['expired height', { getBlockHeight: () => 2000 }, 'PREVIEW_WINDOW_HEIGHT_EXPIRED'],
]) test(name + ' refuses a complete preview without advancing to another window', async () => {
  const rpc = fixture(override);
  await assert.rejects(quotePreviewFeeWindows({ plan: makePlan(), rpc, windowSize: 2 }), error => error.checkCode === code);
  assert.equal(rpc.calls.filter(c => c.method === 'getLatestBlockhash').length, 1);
});

test('partially signed templates cannot be converted into quote candidates', async () => {
  const plan = makePlan(1), tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transactionBase64, 'base64'));
  tx.signatures[0][0] = 1; plan.steps[0].transactionBase64 = Buffer.from(tx.serialize()).toString('base64');
  const rpc = fixture();
  await assert.rejects(quotePreviewFeeWindows({ plan, rpc }), /PREVIEW_REQUIRES_UNSIGNED_TEMPLATE/);
  assert.equal(rpc.calls.filter(c => c.method === 'getFeeForMessage').length, 0);
});

test('duplicate step IDs and invalid window sizes fail before any RPC', async () => {
  const plan = makePlan(2); plan.steps[1].id = plan.steps[0].id;
  const rpc = fixture();
  await assert.rejects(quotePreviewFeeWindows({ plan, rpc }), /DUPLICATE_PREVIEW_STEP/);
  for (const windowSize of [0, 25, 1.5, '2']) await assert.rejects(quotePreviewFeeWindows({ plan: makePlan(1), rpc, windowSize }), /INVALID_PREVIEW_WINDOW/);
  assert.equal(rpc.calls.length, 0);
});

test('preview refuses a non-Devnet genesis before creating any plan or temporary journal', async () => {
  const calls = [];
  const result = await previewDevnetDeployment({ endpoint: 'https://rpc-fixture.example/?token=PRIVATE_SENTINEL',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }));
    } });
  assert.deepEqual(calls, ['getGenesisHash']);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'RPC_GENESIS');
  assert.equal(result.keysCreated, 0); assert.equal(result.transactionsSent, 0);
  assert.equal(result.productionBundleCreated, false); assert.equal(result.salesOpen, false);
  assert.equal(result.estimates, null); assert.equal(result.budgetComplete, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});

test('public RPC rejection is reported once, without retries, fallback or credential echo', async () => {
  let calls = 0;
  const result = await previewDevnetDeployment({ endpoint: 'https://rpc-fixture.example/?token=PRIVATE_SENTINEL',
    fetchImpl: async () => { calls++; return new Response('PRIVATE_SENTINEL', { status: 429 }); } });
  assert.equal(calls, 1); assert.equal(result.code, 'RPC_HTTP');
  assert.equal(result.estimates, null); assert.equal(result.everyMessageQuoted, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
});
