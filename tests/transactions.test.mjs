import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { devnetUmi, collectionBuilder } from '../solana/builders.mjs';
import { sendTracked, canDiscardPending } from '../solana/transactions.mjs';

function fixture() {
  const umi = devnetUmi(); umi.use(signerIdentity(generateSigner(umi)));
  const collection = generateSigner(umi);
  const state = { owner: umi.identity.publicKey, transactions: [] };
  const saved = [];
  umi.rpc.call = async (method, params) => {
    assert.equal(method, 'getLatestBlockhash');
    assert.deepEqual(params, [{ commitment: 'confirmed' }]);
    return { context: { slot: 200 }, value: { blockhash: collection.publicKey, lastValidBlockHeight: 100 } };
  };
  umi.rpc.getBlockHeight = async options => {
    assert.deepEqual(options, { commitment: 'confirmed', minContextSlot: 200 });
    return 90n;
  };
  const submit = () => sendTracked(umi, collectionBuilder(umi, collection), state, s => saved.push(structuredClone(s)),
    { kind: 'collection', address: collection.publicKey }, () => { state.collection = collection.publicKey; });
  return { umi, state, saved, submit };
}

test('A lost broadcast response retains the real signed transaction and blocks another send', async () => {
  const { umi, state, saved, submit } = fixture(); let sends = 0;
  umi.rpc.sendTransaction = async (tx, options) => {
    assert.deepEqual(options, { preflightCommitment: 'confirmed', minContextSlot: 200, skipPreflight: false, maxRetries: 3 });
    sends++;
    assert.equal(saved.at(-1).pending.signature, base58.deserialize(tx.signatures[0])[0]);
    assert.equal(saved.at(-1).collection, state.collection);
    throw new Error('Response lost');
  };
  await assert.rejects(submit(), /Response lost/);
  assert.equal(state.transactions.length, 1);
  assert.ok(state.pending.signature);
  await assert.rejects(submit(), /Предыдущая операция/);
  assert.equal(sends, 1);
});

test('A confirmed send clears pending but preserves its signature in the backup', async () => {
  const { umi, state, saved, submit } = fixture();
  umi.rpc.sendTransaction = async tx => tx.signatures[0];
  umi.rpc.confirmTransaction = async signature => {
    assert.equal(base58.deserialize(signature)[0], state.pending.signature);
    return { value: { err: null } };
  };
  await submit();
  assert.equal(state.pending, undefined);
  assert.equal(saved.at(-1).transactions.length, 1);
});

test('Wallet cancellation creates no pending operation and sends nothing', async () => {
  const { umi, state, submit } = fixture(); let sent = false;
  umi.identity.signTransaction = async () => { throw new Error('Cancelled'); };
  umi.rpc.sendTransaction = async () => { sent = true; };
  await assert.rejects(submit(), /Cancelled/);
  assert.equal(sent, false);
  assert.equal(state.pending, undefined);
  assert.equal(state.collection, undefined);
});

function statusRpc(status, height = 101, contextSlot = 200) {
  const calls = [];
  return { calls, call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'getSlot') return 200;
    if (method === 'getBlockHeight') return height;
    if (method === 'getSignatureStatuses') return { context: { slot: contextSlot }, value: [status] };
    throw Error(method);
  } };
}
const pending = { signature: 'test-signature', lastValidBlockHeight: 100 };

test('Expiry never discards a successful transaction while account reads are delayed', async () => {
  for (const confirmationStatus of ['processed', 'confirmed', 'finalized']) {
    assert.equal(await canDiscardPending(statusRpc({ err: null, confirmationStatus }), pending), false);
  }
});

test('Only an expired absent transaction or finalized failure can be discarded', async () => {
  assert.equal(await canDiscardPending(statusRpc(null, 100), pending), false);
  const rpc = statusRpc(null);
  assert.equal(await canDiscardPending(rpc, pending), true);
  assert.deepEqual(rpc.calls[1].params, [{ commitment: 'finalized', minContextSlot: 200 }]);
  assert.deepEqual(rpc.calls[2].params, [[pending.signature], { searchTransactionHistory: true }]);
  assert.equal(await canDiscardPending(statusRpc({ err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' }), pending), false);
  assert.equal(await canDiscardPending(statusRpc({ err: { InstructionError: [0, 'x'] }, confirmationStatus: 'finalized' }), pending), true);
});

test('Stale, unavailable, malformed or legacy evidence never enables a retry', async () => {
  assert.equal(await canDiscardPending(statusRpc(null, 101, 199), pending), false);
  assert.equal(await canDiscardPending(statusRpc(undefined), pending), false);
  assert.equal(await canDiscardPending(statusRpc(null), { lastValidBlockHeight: 100 }), false);
  assert.equal(await canDiscardPending(statusRpc(null), { ...pending, lastValidBlockHeight: NaN }), false);
  await assert.rejects(canDiscardPending({ call: async () => { throw Error('RPC unavailable'); } }, pending), /RPC unavailable/);
});


test('Slow mobile signature expires without broadcast or saved account; next attempt signs fresh data', async () => {
  const { umi, state, saved, submit } = fixture();
  umi.rpc.getBlockHeight = async () => 101n;
  let sends = 0;
  umi.rpc.sendTransaction = async tx => { sends++; return tx.signatures[0]; };
  await assert.rejects(submit(), /Срок транзакции истёк/);
  assert.equal(sends, 0); assert.equal(saved.length, 0); assert.equal(state.collection, undefined);
  umi.rpc.getBlockHeight = async () => 90n;
  umi.rpc.confirmTransaction = async () => ({ value: { err: null } });
  await submit(); assert.equal(sends, 1);
});

test('Blockhash preflight failure preserves signature and blocks immediate duplicate creation', async () => {
  const { umi, state, submit } = fixture(); let sends = 0;
  umi.rpc.sendTransaction = async () => { sends++; throw Error('Simulation failed: Blockhash not found'); };
  await assert.rejects(submit(), /Blockhash not found/);
  assert.ok(state.pending.signature);
  await assert.rejects(submit(), /Предыдущая операция/);
  assert.equal(sends, 1);
});

test('Malformed blockhash context fails before requesting a wallet signature', async () => {
  const { umi, submit } = fixture();
  umi.rpc.call = async () => undefined;
  umi.identity.signTransaction = async () => { assert.fail('Must not sign'); };
  await assert.rejects(submit(), /свежие данные/);
});
