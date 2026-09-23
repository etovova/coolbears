import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import { buyerCost, revealCost, priorityFeeLamports, ownerChainScenario } from '../costs/model.mjs';
import { sponsoredMintTemplate, syntheticRevealMetadata, syntheticRevealTemplate } from '../costs/templates.mjs';
import { previewLifecycleCosts } from '../costs/preview.mjs';
import { unsignedVmTransaction } from '../deployment/isolated.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { policy } from '../prepare.mjs';
import services from '../costs/services.json' with { type: 'json' };

const standard = { priceLamports: '200000000', rentLamports: '1452880', protocolLamports: '1500000', baseFeeLamports: '10000' };
test('buyer total includes payment, Core charge, account rent and a two-signature fee for every asset', () => {
  assert.equal(buyerCost({ ...standard, quantity: 1 }).total.sol, '0.202962880');
  const fifty = buyerCost({ ...standard, quantity: 50 });
  assert.equal(fifty.total.sol, '10.148144000'); assert.equal(fifty.price.sol, '10.000000000');
  assert.equal(fifty.baseNetworkFees.lamports, '500000'); assert.equal(fifty.publicMintCurrentlyAllowed, false);
  assert.equal(buyerCost({ ...standard, quantity: 50, priorityLamports: '3000' }).total.lamports, '10148294000');
});
test('budget arithmetic refuses floats, signs, unsafe quantity and u64 overflow', () => {
  for (const quantity of [0, 51, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buyerCost({ ...standard, quantity }));
  for (const priceLamports of [-1, '-1', '01', '0.2', '1e9', ' 1', '18446744073709551616']) {
    assert.throws(() => buyerCost({ ...standard, quantity: 1, priceLamports }));
  }
  assert.equal(buyerCost({ ...standard, quantity: 1, priceLamports: '9007199254740993' }).total.lamports, '9007199257703873');
});
test('priority fee rounds up fractional lamports and uses requested CU limit', () => {
  assert.equal(priorityFeeLamports(300000, '0'), '0');
  assert.equal(priorityFeeLamports(300000, '1'), '1');
  assert.equal(priorityFeeLamports(300000, '1000'), '300');
  assert.equal(priorityFeeLamports(300000, '10000'), '3000');
  assert.throws(() => priorityFeeLamports(1400001, '1000'));
  assert.throws(() => priorityFeeLamports(300000, '-1'));
});
test('reveal rent refunds do not lower gross funding and growth is charged separately from network fees', () => {
  const shrink = revealCost({ quantity: 10000, oldRentLamports: '1452880', newRentLamports: '1371600', baseFeeLamports: '5000' });
  assert.equal(shrink.possibleRentRefund.sol, '0.812800000');
  assert.equal(shrink.grossFundingBeforeRefunds.sol, '0.050000000');
  assert.equal(shrink.refundUsedToReduceFunding, false);
  const grow = revealCost({ quantity: 10000, oldRentLamports: '1452880', newRentLamports: '1717040', baseFeeLamports: '5000' });
  assert.equal(grow.grossFundingBeforeRefunds.sol, '2.691600000');
  assert.equal(grow.possibleRentRefund.lamports, '0');
  const owner = ownerChainScenario('4442895320', grow);
  assert.equal(owner.grossChainSubtotal.sol, '7.134495320');
  assert.equal(owner.includesBuyerCosts, false); assert.equal(owner.budgetComplete, false);
  assert.equal(owner.fundingRecommendationLamports, null);
});
test('synthetic reveal metadata has exact ASCII URI bytes and cannot accept a real CID or URI', () => {
  for (const n of [52, 80, 120, 200]) {
    const m = syntheticRevealMetadata(1234, n);
    assert.equal(Buffer.byteLength(m.uri), n); assert.equal(new URL(m.uri).hostname, 'example.invalid');
    assert.equal(m.name, 'CoolBears #1234');
  }
  for (const n of ['https://real.example/private.json', 39, 201, 80.5]) assert.throws(() => syntheticRevealMetadata(1234, n));
  assert.throws(() => syntheticRevealMetadata(10000, 80));
});
test('sponsored and reveal templates stay unsigned and build while all network calls are forbidden', () => {
  const previous = globalThis.fetch; globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN'); };
  try {
    const address = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
    const blockhash = new LiteSVM().latestBlockhash(), payer = address(11), asset = address(12);
    const roles = { machine: address(13), collection: address(14), guard: address(15) };
    const mint = sponsoredMintTemplate({ payer, asset, roles, blockhash });
    const { tx } = unsignedVmTransaction(Buffer.from(mint).toString('base64'));
    assert.equal(tx.signatures.length, 3);
    assert.deepEqual(new Set(tx.message.staticAccountKeys.slice(0, 3).map(k => k.toBase58())), new Set([payer, policy.owner, asset]));
    const reveal = syntheticRevealTemplate({ asset, collection: roles.collection, index: 1234, uriBytes: 80, blockhash });
    assert.equal(unsignedVmTransaction(Buffer.from(reveal).toString('base64')).tx.signatures.length, 1);
    assert.equal(VersionedTransaction.deserialize(reveal).message.staticAccountKeys[0].toBase58(), policy.owner);
    assert.throws(() => sponsoredMintTemplate({ payer: policy.owner, asset, roles, blockhash }));
  } finally { globalThis.fetch = previous; }
});
test('service references preserve unknown invoices, hosting and different billing periods', () => {
  assert.equal(services.actualInvoiceTotal, null); assert.equal(services.budgetComplete, false);
  assert.equal(services.actualAccountPlansVerified, false);
  for (const s of services.illustrativeMonthlyServiceSubtotals) {
    assert.equal(Number(s.pinataPicnicUsd) + Number(s.heliusUsd) + Number(s.workersUsd), Number(s.subtotalUsd));
  }
  assert.ok(services.subtotalExclusions.includes('website hosting'));
  assert.ok(services.subtotalExclusions.includes('domain renewal'));
  assert.equal(services.services.at(-1).actualMonthlyUsd, null);
});
test('lifecycle preview refuses wrong genesis before local execution and never echoes provider credentials', async () => {
  const methods = [];
  const { report, snapshot } = await previewLifecycleCosts({ endpoint: 'https://rpc.example/?api-key=secret-value',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body); methods.push(request.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: GENESIS_HASHES['mainnet-beta'] }));
    } });
  assert.deepEqual(methods, ['getGenesisHash']); assert.equal(snapshot, undefined);
  assert.equal(report.status, 'blocked'); assert.equal(report.code, 'RPC_GENESIS');
  assert.equal(report.transactionsSent, 0); assert.equal(report.fundingRecommendationLamports, null);
  assert.doesNotMatch(JSON.stringify(report), /secret-value|api-key/);
});
test('rate limit ends the lifecycle preview without retry or fallback', async () => {
  let calls = 0;
  const { report } = await previewLifecycleCosts({ endpoint: 'https://rpc.example/',
    fetchImpl: async () => { calls++; return new Response('private-provider-message', { status: 429 }); } });
  assert.equal(calls, 1); assert.equal(report.status, 'blocked'); assert.equal(report.code, 'RPC_HTTP');
  assert.equal(report.budgetComplete, false); assert.doesNotMatch(JSON.stringify(report), /private-provider-message/);
});
