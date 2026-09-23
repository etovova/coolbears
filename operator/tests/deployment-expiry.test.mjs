import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { verifyExpiredTransaction, anchorFromLatestBlockhash, validExpiryEvidence } from '../deployment/expiry.mjs';
import { inspectSignedDeploymentTransaction } from '../deployment/signing.mjs';
import { GENESIS_HASHES, createDeploymentRpc } from '../deployment/rpc.mjs';
const key = s => Keypair.fromSeed(createHash('sha256').update(`expiry-fixture:${s}`).digest());
const owner = key('owner'), blockhash = key('hash').publicKey.toBase58();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash,
  instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: key('to').publicKey, lamports: 1 })] }).compileToV0Message());
tx.sign([owner]);
const transactionBase64 = Buffer.from(tx.serialize()).toString('base64'), signed = inspectSignedDeploymentTransaction(transactionBase64);
const anchor = { version: 1, blockhash, slot: 1000, lastValidBlockHeight: 850 };
const signature = s => base58.deserialize(createHash('sha512').update(String(s)).digest())[0];
const row = (slot, id = slot) => ({ slot, signature: signature(id), err: null, confirmationStatus: 'finalized' });
function fixture({ edit = () => {}, pages = [[row(1100), row(999)]], onCall } = {}) {
  const calls = [], values = { getGenesisHash: GENESIS_HASHES.devnet,
    getBlock: { blockhash, blockHeight: 700, parentSlot: 999 },
    horizon: { blockhash: key('horizon').publicKey.toBase58(), blockHeight: 900, parentSlot: 1199 },
    isBlockhashValid: { context: { slot: 1200 }, value: false }, getFirstAvailableBlock: 1,
    getSignatureStatuses: { context: { slot: 1300 }, value: [null] }, getTransaction: null };
  edit(values); let page = 0;
  const call = async (method, params = []) => {
    calls.push({ method, params: structuredClone(params) }); await onCall?.(method, values, calls);
    if (method === 'getBlock') {
      assert.deepEqual(params[1], { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 });
      return structuredClone(params[0] === anchor.slot ? values.getBlock : values.horizon);
    }
    if (method === 'getSignaturesForAddress') {
      assert.equal(params[0], owner.publicKey.toBase58()); assert.equal(params[1].commitment, 'finalized');
      assert.equal(params[1].minContextSlot, 1200); assert.equal(params[1].limit, 100);
      if (page) assert.equal(params[1].before, pages[page - 1].at(-1).signature);
      return structuredClone(pages[page++]);
    }
    assert.ok(Object.hasOwn(values, method), method); return structuredClone(values[method]);
  };
  return { calls, call, run: extra => verifyExpiredTransaction({ transactionBase64, anchor, call, ...extra }) };
}
test('expiry requires an anchored finalized block, a closed lifetime and history crossing its lower boundary', async () => {
  const f = fixture(), proof = await f.run(); assert.ok(validExpiryEvidence(proof));
  assert.equal(proof.anchorSlot, 1000); assert.equal(proof.slot, 1200); assert.equal(proof.blockHeight, 900);
  assert.equal(proof.lastValidBlockHeight, 850); assert.equal(proof.historyPages, 1);
  assert.equal(f.calls.filter(c => c.method === 'getSignatureStatuses').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'getFirstAvailableBlock').length, 2);
  assert.equal(f.calls.length, 11); assert.equal(f.calls.some(c => /send|simulate/.test(c.method)), false);
});
test('empty receipts, a clock delay or invalid hash without an anchor cannot retire an attempt', async () => {
  for (const candidate of [undefined, null, {}, { ...anchor, slot: 0 }, { ...anchor, blockhash: key('wrong').publicKey.toBase58() }]) {
    const f = fixture(); await assert.rejects(f.run({ anchor: candidate })); assert.equal(f.calls.length, 0);
  }
  for (const result of [null, {}, { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 0 } },
    { context: { slot: 1 }, value: { blockhash: 'invalid', lastValidBlockHeight: 850 } }])
    assert.throws(() => anchorFromLatestBlockhash(result));
});
test('wrong cluster, forked or pruned anchor, unexpired hash, invalid horizon and any observed outcome block expiry', async () => {
  const changes = [v => { v.getGenesisHash = GENESIS_HASHES['mainnet-beta']; }, v => { v.getBlock = null; },
    v => { v.getBlock.blockhash = key('fork').publicKey.toBase58(); },
    v => { v.isBlockhashValid.value = true; }, v => { v.isBlockhashValid.context.slot = 999; },
    v => { v.horizon.blockHeight = 850; }, v => { v.horizon.blockHeight = null; },
    v => { v.getFirstAvailableBlock = 1001; }, v => { v.getSignatureStatuses.value[0] = { err: null }; },
    v => { v.getSignatureStatuses.context.slot = 1199; }, v => { v.getTransaction = {}; }];
  for (const edit of changes) await assert.rejects(fixture({ edit }).run());
});
test('paged finalized payer history must be ordered, exclusive and complete through the anchor', async () => {
  const first = Array.from({ length: 100 }, (_, i) => row(1100 - i));
  const complete = fixture({ pages: [first, [row(1000), row(999)]] });
  assert.equal((await complete.run()).historyPages, 2);
  for (const pages of [[[]], [[row(1100)]], [first, []], [[row(1000)]],
    [[row(999), row(1001)]], [[row(1100), row(999, 1100)]],
    [[{ ...row(999), confirmationStatus: 'confirmed' }]], [[{ ...row(999), signature: signed.signature }]],
    [first, [row(1000), row(999, 1100)]]]) await assert.rejects(fixture({ pages }).run());
});
test('history caps, pruning during pagination and a receipt appearing during the scan never authorize retry', async () => {
  const pages = Array.from({ length: 10 }, (_, page) => Array.from({ length: 100 }, (_, i) => row(3000 - page * 100 - i)));
  const capped = fixture({ pages }); await assert.rejects(capped.run(), e => e.code === 'EXPIRY_HISTORY_LIMIT');
  assert.equal(capped.calls.filter(c => c.method === 'getSignaturesForAddress').length, 10);
  for (const mode of ['pruned', 'status', 'receipt']) {
    let seen = false;
    await assert.rejects(fixture({ onCall(method, values) {
      if (method === 'getSignaturesForAddress') seen = true;
      if (seen && mode === 'pruned') values.getFirstAvailableBlock = 1001;
      if (seen && mode === 'status') values.getSignatureStatuses.value[0] = { err: null };
      if (seen && mode === 'receipt') values.getTransaction = {};
    } }).run());
  }
});
test('expiry transport requires a separate exact signed-byte grant and explicit access for internal history reads', async () => {
  const endpoint = 'https://expiry.test/rpc', calls = [];
  const fetchImpl = async (_url, init) => { const call = JSON.parse(init.body); calls.push(call);
    if (call.method === 'coolbears_authorizeExpiredRetry') throw Error('private sentinel');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: GENESIS_HASHES.devnet })); };
  const readOnly = createDeploymentRpc({ endpoint, fetchImpl });
  for (const method of ['coolbears_authorizeExpiredRetry', 'getBlock', 'getSignaturesForAddress', 'getFirstAvailableBlock']) await assert.rejects(readOnly.call(method, []));
  const rpc = createDeploymentRpc({ endpoint, fetchImpl, expiredRetry: { transactionBase64 } });
  await assert.rejects(rpc.call('coolbears_authorizeExpiredRetry', [transactionBase64])); assert.equal(calls.length, 0);
  await rpc.call('getGenesisHash'); await assert.rejects(rpc.call('coolbears_authorizeExpiredRetry', ['wrong']));
  await assert.rejects(rpc.call('coolbears_authorizeExpiredRetry', [transactionBase64]));
  await assert.rejects(rpc.call('coolbears_authorizeExpiredRetry', [transactionBase64])); assert.equal(calls.length, 2);
  assert.throws(() => createDeploymentRpc({ endpoint, failedRetry: { transactionBase64 }, expiredRetry: { transactionBase64 } }));
});
