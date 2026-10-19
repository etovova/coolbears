// Intercepted RPC fixtures and official unsigned SDK instructions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { policy } from '../prepare.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { createAccountVerifier } from '../deployment/accounts-model.mjs';
import { createOrderModel } from '../orders/journal-model.mjs';
import { createOrderPlanner } from '../orders/transaction-model.mjs';
import { createOrderChecker } from '../orders/preflight-model.mjs';
import { baseAssetBytes, CORE_CREATE_LAMPORTS } from '../orders/mint-cost.mjs';
import { hiddenAccountFixtures, fixtureRpcAccount } from './fixtures/hidden-accounts.mjs';

const address = label => { for (let n = 0; ; n++) {
  const bytes = createHash('sha256').update(`hidden-preflight-fixture:${label}:${n}`).digest();
  if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58();
} };
const options = { storageMode: 'hidden-settings', hiddenCommitmentSha256:
  createHash('sha256').update('SYNTHETIC-PREFLIGHT-PRIVATE-MAPPING').digest('hex') };
const roles = { machine: address('machine'), collection: address('collection') };
const fixture = hiddenAccountFixtures({ policy, storageOptions: options, roles });
const model = createOrderModel(policy, options), planner = createOrderPlanner(model);
const verifier = createAccountVerifier(policy, options);
const checker = createOrderChecker(policy, { ...model, ...planner, ...verifier }, options);
const blockhash = address('blockhash'), endpoint = 'https://hidden-preflight-fixture.test/';

function harness({ redeemed = 0, finalRedeemed = redeemed, simulatedIndex = redeemed + 1,
  balance, orderMutation, mutate } = {}) {
  const order = model.createOrder({ id: 'hidden-cost-fixture', cluster: 'devnet', buyer: policy.owner,
    machine: roles.machine, collection: roles.collection, guard: fixture.guard,
    quantity: 1, available: 9999, assets: [address('asset')] });
  const assetSize = baseAssetBytes(policy, order, redeemed + 1, options).length;
  const rent = BigInt((assetSize + 128) * 5080);
  const budgetAssetSize = baseAssetBytes(policy, order, policy.supply - 1, options).length;
  const budgetRent = BigInt((budgetAssetSize + 128) * 5080);
  const actualMinimum = 200000000n + 10000n + rent + CORE_CREATE_LAMPORTS;
  const minimum = 200000000n + 10000n + budgetRent + CORE_CREATE_LAMPORTS;
  let accountReads = 0; const calls = [];
  const fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    if (call.method === 'getMultipleAccounts') accountReads++;
    const currentRedeemed = accountReads > 1 ? finalRedeemed : redeemed;
    const assets = baseAssetBytes(policy, order, simulatedIndex, options);
    let result = {
      getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 600 }, value: [
        { executable: true }, { executable: true }, { executable: true },
        fixture.machineAccount(currentRedeemed), fixture.guardAccount(),
        fixture.collectionAccount(currentRedeemed), null] },
      getBalance: { context: { slot: 600 }, value: balance ?? Number(minimum) },
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash, lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 10000 },
      getMinimumBalanceForRentExemption: (call.params[0] + 128) * 5080,
      simulateTransaction: { context: { slot: 600 }, value: { err: null,
        unitsConsumed: 99999, accounts: [fixtureRpcAccount(assets, MPL_CORE_PROGRAM_ID,
          Number(rent + CORE_CREATE_LAMPORTS))] } },
      isBlockhashValid: { context: { slot: 600 }, value: true }, getBlockHeight: 1800,
    }[call.method];
    assert.notEqual(result, undefined, call.method);
    if (mutate) result = mutate(call, result);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  };
  return { order, calls, assetSize, rent, budgetAssetSize, budgetRent, actualMinimum, minimum, run: () => checker.preflightOrder({
    readOrder: () => orderMutation ? orderMutation(structuredClone(order)) : structuredClone(order), endpoint, fetchImpl }) };
}

test('hidden simulations retain the trusted index while every decimal width receives the largest account rent budget', async () => {
  for (const redeemed of [0, 8, 9, 98, 99, 998, 999, 9998]) {
    const h = harness({ redeemed }), before = structuredClone(h.order), report = await h.run();
    assert.equal(report.status, 'preflight-passed', JSON.stringify(report));
    const rentCalls = h.calls.filter(call => call.method === 'getMinimumBalanceForRentExemption');
    assert.deepEqual(rentCalls.map(call => call.params[0]), h.assetSize === h.budgetAssetSize ? [h.assetSize] : [h.assetSize, h.budgetAssetSize]);
    assert.equal(report.budget.baseAssetBytes, h.assetSize);
    assert.equal(report.budget.observedBaseRentLamports, h.rent.toString());
    assert.equal(report.budget.rentBudgetAssetBytes, h.budgetAssetSize);
    assert.equal(report.budget.nextItemBaseRentLamports, h.budgetRent.toString());
    assert.equal(report.budget.protocolChargesLamports, '1500000');
    assert.equal(report.budget.nextItemKnownMinimumLamports, h.minimum.toString());
    assert.equal(report.budget.unitPriceLamports, '200000000');
    const tx = VersionedTransaction.deserialize(Buffer.from(report.candidate.transactionBase64, 'base64'));
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), h.order.buyer);
    assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)));
    assert.deepEqual(h.order, before);
    assert.equal(report.signaturesCreated + report.transactionsSent + report.journalWrites, 0);
    assert.equal(report.readyToSubmit, false); assert.equal(report.salesOpen, false);
  }
});

test('hidden buyer balance must cover price, transaction fee, largest-index rent funding and Core charge', async () => {
  const baseline = harness({ redeemed: 9 });
  const poor = harness({ redeemed: 9, balance: Number(baseline.minimum - 1n) });
  const report = await poor.run();
  assert.equal(report.code, 'INSUFFICIENT_BALANCE');
  assert.equal(poor.calls.some(call => call.method === 'simulateTransaction'), false);
});

test('a balance covering only the observed short index cannot approve the maximum rent funding reserve', async () => {
  const baseline = harness({ redeemed: 8 });
  assert.ok(baseline.actualMinimum < baseline.minimum);
  const poor = harness({ redeemed: 8, balance: Number(baseline.actualMinimum) });
  assert.equal((await poor.run()).code, 'INSUFFICIENT_BALANCE');
  assert.equal(poor.calls.some(call => call.method === 'simulateTransaction'), false);
  const exact = harness({ redeemed: 8, balance: Number(baseline.minimum) });
  const report = await exact.run();
  assert.equal(report.status, 'preflight-passed', JSON.stringify(report));
  assert.equal(report.budget.observedBaseRentLamports, baseline.rent.toString());
  assert.equal(report.budget.nextItemBaseRentLamports, baseline.budgetRent.toString());
});

test('the final buyer balance reread still needs the maximum rent reserve after successful actual-index simulation', async () => {
  const baseline = harness({ redeemed: 8 });let balances = 0;
  const h = harness({ redeemed: 8, mutate: (call, result) => {
    if (call.method === 'getBalance' && ++balances === 2) result.value = Number(baseline.actualMinimum);
    return result;
  } });
  const report = await h.run();assert.equal(report.code, 'INSUFFICIENT_BALANCE');
  assert.equal(h.calls.filter(call => call.method === 'simulateTransaction').length, 1);
  assert.equal(report.readyToSign, false);
});

test('unavailable or nonmonotonic largest-index rent quotes block before simulation without an arithmetic fallback', async () => {
  const baseline = harness({ redeemed: 8 });
  for (const value of [0, Number(baseline.rent - 1n), null]) {
    const h = harness({ redeemed: 8, mutate: (call, result) =>
      call.method === 'getMinimumBalanceForRentExemption' && call.params[0] === baseline.budgetAssetSize ? value : result });
    assert.equal((await h.run()).status, 'blocked');
    assert.equal(h.calls.some(call => call.method === 'simulateTransaction'), false);
  }
});

test('hidden simulated metadata and final inventory must retain the exact quoted index', async () => {
  const wrong = harness({ redeemed: 8, simulatedIndex: 10 });
  assert.equal((await wrong.run()).code, 'MINT_COST_UNVERIFIED');
  const changed = harness({ redeemed: 8, finalRedeemed: 9 });
  const report = await changed.run();
  assert.equal(report.code, 'MINT_INDEX_CHANGED'); assert.equal(report.candidate, undefined);
  assert.equal(report.readyToSign, false);
});

test('hidden commitment substitution and padded legacy simulation are never silently accepted', async () => {
  const substituted = harness({ orderMutation: order => ({ ...order, hiddenCommitmentSha256: 'f'.repeat(64) }) });
  const stopped = await substituted.run();
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.networkRequests, 0);
  const padded = harness({ mutate: (call, result) => {
    if (call.method === 'simulateTransaction') {
      const legacyOrder = { buyer: policy.owner, collection: roles.collection };
      result.value.accounts[0].data[0] = Buffer.from(baseAssetBytes(policy, legacyOrder)).toString('base64');
    }
    return result;
  } });
  assert.equal((await padded.run()).code, 'MINT_COST_UNVERIFIED');
});
