// Real SDK layouts and RPC transport; all responses and addresses are fixtures.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { CANDY_MACHINE_HIDDEN_SECTION } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCandyMachineAccountDataSerializer as machineSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { getCollectionV1AccountDataSerializer as collectionSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { buildDeploymentPlan } from '../deployment/plan.mjs';
import { verifyOrderAccounts, verifyExpectedAccounts, expectedAccountAddresses } from '../deployment/accounts.mjs';
import { insertionAccounts } from './fixtures/group-accounts.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { policy } from '../prepare.mjs';
import { createOrder, transitionOrder } from '../orders/journal.mjs';
import { preflightOrder } from '../orders/preflight.mjs';
import { runOrderCheck } from '../orders/check.mjs';

const address = label => {
  for (let n = 0; ; n++) { const bytes = createHash('sha256').update(`order-read:${label}:${n}`).digest();
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58(); }
};
const endpoint = 'https://order-fixture.test/?api-key=SECRET-FIXTURE', blockhash = address('hash');
const originalFetch = globalThis.fetch;
let plan, full;
before(async () => {
  globalThis.fetch = () => assert.fail('Live network forbidden');
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: address('collection'), reservedAsset: address('other'),
    machine: address('machine'), blockhash, lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
  full = insertionAccounts({ steps: plan.steps }, 9999);
});
after(() => { globalThis.fetch = originalFetch; });
function order(quantity = 1, changes = {}) {
  return createOrder({ id: 'buyer-read-fixture', cluster: 'devnet', buyer: policy.owner,
    machine: plan.roles.machine, guard: plan.roles.guard, collection: plan.roles.collection,
    quantity, available: 9999, assets: Array.from({ length: quantity }, (_, n) => address(`asset-${n}`)), ...changes });
}
const bytes = account => Buffer.from(account.data[0], 'base64');
function changeAccount(account, edit) {
  const data = bytes(account); edit(data); return { ...account, data: [data.toString('base64'), 'base64'] };
}
function accounts(redeemed = 0) {
  const value = structuredClone(full);
  value[5] = changeAccount(value[5], data => {
    const [base] = machineSerializer().deserialize(data);
    data.set(machineSerializer().serialize({ ...base, itemsRedeemed: BigInt(redeemed) }));
  });
  value[3] = changeAccount(value[3], data => {
    const [base] = collectionSerializer().deserialize(data);
    data.set(collectionSerializer().serialize({ ...base, numMinted: redeemed + 1, currentSize: redeemed + 1 }));
  });
  return value;
}
function harness({ quantity = 1, buyer = policy.owner, redeemed = 0, transform, revise } = {}) {
  let saved = order(quantity, { buyer }), reads = 0, accountReads = 0;
  const base = accounts(redeemed), calls = [];
  const readOrder = () => { reads++; if (reads > 1 && revise) saved = revise(saved); return structuredClone(saved); };
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    assert.equal(init.redirect, 'error');
    if (call.method === 'getMultipleAccounts') accountReads++;
    let result = {
      getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 600 }, value: [...base.slice(0, 3), base[5], base[6], base[3], ...Array(quantity).fill(null)] },
      getBalance: { context: { slot: 600 }, value: 20000000000 },
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash, lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 10000 },
      getMinimumBalanceForRentExemption: 1999999,
      simulateTransaction: { context: { slot: 600 }, value: { err: null, unitsConsumed: 99999 } },
      isBlockhashValid: { context: { slot: 600 }, value: true }, getBlockHeight: 1800,
    }[call.method];
    assert.notEqual(result, undefined, call.method);
    if (transform) result = transform(call, result, accountReads);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  };
  return { calls, readOrder, fetchImpl, initial: () => structuredClone(saved),
    run: () => preflightOrder({ readOrder, endpoint, fetchImpl }) };
}
for (const quantity of [1, 50]) test(`fresh ${quantity}-item order validates a full machine and only simulates the first exact message`, async () => {
  const h = harness({ quantity, redeemed: 7 }), before = h.initial();
  const report = await h.run(); assert.equal(report.status, 'preflight-passed', JSON.stringify(report));
  assert.equal(report.itemsRemaining, 9992); assert.equal(report.quantity, quantity);
  assert.equal(report.budget.orderItemPriceLamports, String(200000000n * BigInt(quantity)));
  assert.equal(report.budget.nextItemKnownMinimumLamports, '202009999'); assert.equal(report.budget.baseAssetBytes, 158);
  assert.equal(report.budget.complete, false); assert.equal(report.budget.protocolChargesLamports, null);
  assert.equal(report.budget.fullOrderTotalLamports, null);
  const sim = h.calls.filter(x => x.method === 'simulateTransaction'); assert.equal(sim.length, 1);
  assert.equal(sim[0].params[0], report.candidate.transactionBase64);
  assert.equal(sim[0].params[1].sigVerify, false); assert.equal(sim[0].params[1].replaceRecentBlockhash, false);
  const tx = VersionedTransaction.deserialize(Buffer.from(report.candidate.transactionBase64, 'base64'));
  assert.equal(tx.version, 0); assert.equal(tx.message.staticAccountKeys[0].toBase58(), before.buyer);
  assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)));
  assert.equal(createHash('sha256').update(tx.message.serialize()).digest('hex'), report.candidate.messageSha256);
  assert.equal(h.calls.length, 11); assert.deepEqual(h.initial(), before);
  assert.equal(report.readyToSign, false); assert.equal(report.salesOpen, false);
  assert.equal(report.signaturesCreated + report.transactionsSent + report.journalWrites, 0);
});

test('ordinary buyer is refused by the closed on-chain guard before any fee quote or simulation', async () => {
  const h = harness({ buyer: address('ordinary-buyer'), quantity: 50 });
  assert.equal((await h.run()).code, 'SALES_CLOSED');
  assert.deepEqual(h.calls.map(x => x.method), ['getGenesisHash', 'getMultipleAccounts']);
});
test('sold-out and insufficient supply are refused; planning availability is never trusted', async () => {
  for (const redeemed of [9999, 9950]) { const h = harness({ quantity: 50, redeemed });
    assert.equal((await h.run()).code, 'INSUFFICIENT_SUPPLY'); assert.equal(h.calls.length, 2); }
});
test('paused, existing, mainnet, invalid quantity and unsignable fresh orders stop before RPC', async () => {
  const pristine = order();
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('unsignable-asset')], new PublicKey(plan.roles.machine))[0].toBase58();
  const pending = transitionOrder(pristine, { type: 'prepare', revision: 0, index: 0,
    blockhash, lastValidBlockHeight: 2000, messageSha256: '0'.repeat(64) });
  for (const saved of [{ ...pristine, paused: true }, pending, { ...pristine, cluster: 'mainnet-beta' },
    { ...pristine, quantity: 51 }, { ...pristine, treasury: address('changed') },
    { ...pristine, items: [{ index: 0, asset: offCurve, attempts: [] }] }]) {
    const report = await preflightOrder({ readOrder: () => saved, endpoint, fetchImpl: () => assert.fail('RPC forbidden') });
    assert.equal(report.status, 'blocked'); assert.equal(report.networkRequests, 0);
  }
});
test('wrong genesis never reads accounts', async () => {
  const h = harness({ transform: (call, result) => call.method === 'getGenesisHash' ? GENESIS_HASHES['mainnet-beta'] : result });
  assert.equal((await h.run()).code, 'RPC_GENESIS'); assert.equal(h.calls.length, 1);
});
test('changed guard, collection royalties, full config lines, indices and program accounts are rejected', async () => {
  const N = 9999, settings = plan.steps[2].expected.configLineSettings;
  const bitmap = CANDY_MACHINE_HIDDEN_SECTION + 4 + N * (settings.nameLength + settings.uriLength), indices = bitmap + Math.floor(N / 8) + 1;
  const mutations = [
    values => { values[0] = { executable: false }; },
    values => { values[3].owner = policy.owner; },
    values => { values[3] = changeAccount(values[3], b => { b[CANDY_MACHINE_HIDDEN_SECTION + 4 + 5000 * (settings.nameLength + settings.uriLength)] ^= 1; }); },
    values => { values[3] = changeAccount(values[3], b => b.writeUInt32LE(0, indices + 4)); },
    values => { values[3] = changeAccount(values[3], b => { b[bitmap] = 0; }); },
    values => { values[3] = changeAccount(values[3], b => b.writeUInt32LE(9998, CANDY_MACHINE_HIDDEN_SECTION)); },
    values => { values[4] = changeAccount(values[4], b => { b[b.length - 1] ^= 1; }); },
    values => { values[4] = changeAccount(values[4], b => { const encoded = Buffer.alloc(8); encoded.writeBigUInt64LE(200000000n);
      const at = b.indexOf(encoded); assert.ok(at >= 0); b[at] ^= 1; }); },
    values => { values[5] = changeAccount(values[5], b => { b[150] ^= 1; }); },
    values => { values[6] = { owner: policy.owner, executable: false }; },
  ];
  for (const mutate of mutations) {
    const h = harness({ transform: (call, result) => { if (call.method === 'getMultipleAccounts') mutate(result.value); return result; } });
    assert.equal((await h.run()).status, 'blocked'); assert.equal(h.calls.length, 2);
  }
});
test('fee, balance, simulation, context and blockhash failures never yield a candidate', async () => {
  const scenarios = [
    ['getFeeForMessage', r => { r.value = null; }], ['getFeeForMessage', r => { r.value = 0; }],
    ['getBalance', r => { r.value = 100; }], ['getBalance', r => { r.value = Number.MAX_SAFE_INTEGER + 1; }],
    ['getLatestBlockhash', r => { r.context.slot = 1; }],
    ['simulateTransaction', r => { r.value.err = { Custom: 1 }; }],
    ['simulateTransaction', r => { r.value.replacementBlockhash = { blockhash }; }],
    ['simulateTransaction', r => { r.value.unitsConsumed = 300001; }],
    ['isBlockhashValid', r => { r.value = false; }],
  ];
  for (const [method, change] of scenarios) {
    const h = harness({ transform: (call, result) => { if (call.method === method) change(result); return result; } });
    const report = await h.run(); assert.equal(report.status, 'blocked', method); assert.equal(report.candidate, undefined);
  }
  const h = harness({ transform: (call, result) => call.method === 'getBlockHeight' ? 1950 : result });
  assert.equal((await h.run()).code, 'BLOCKHASH_TOO_OLD');
});
test('changed accounts, insufficient supply or a new asset after simulation stop; order mutation stops a stale result', async () => {
  const h = harness({ transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) result.value[4] = null; return result;
  } }); assert.equal((await h.run()).code, 'ACCOUNT_STATE_MISMATCH');
  const sold = accounts(9950);
  const dwindled = harness({ quantity: 50, transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) {
      result.value[3] = sold[5]; result.value[5] = sold[3];
    } return result;
  } }); assert.equal((await dwindled.run()).code, 'INSUFFICIENT_SUPPLY');
  const occupied = harness({ transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) result.value[6] = { owner: policy.owner }; return result;
  } }); assert.equal((await occupied.run()).code, 'ASSET_ALREADY_EXISTS');
  const changed = harness({ revise: saved => ({ ...saved, id: 'other-order' }) });
  assert.equal((await changed.run()).code, 'ORDER_CHANGED');
});
test('mint-ready state accepts the remaining random index pool without relaxing deployment checks', () => {
  const values = accounts(5), expected = plan.steps[2].expected, N = 9999, s = expected.configLineSettings;
  const offset = CANDY_MACHINE_HIDDEN_SECTION + 4 + N * (s.nameLength + s.uriLength) + Math.floor(N / 8) + 1;
  values[5] = changeAccount(values[5], b => { const a = b.readUInt32LE(offset), z = b.readUInt32LE(offset + 10 * 4);
    b.writeUInt32LE(z, offset); b.writeUInt32LE(a, offset + 10 * 4);
    b.writeUInt32LE(0xffffffff, offset + (N - 1) * 4); });
  assert.equal(verifyOrderAccounts(order(), [values[5], values[6], values[3]]).itemsRemaining, 9994);
  assert.throws(() => verifyExpectedAccounts({ ...expected, itemsLoaded: N }, expectedAccountAddresses(expected), [values[5], values[6]]));
});
test('CLI reads an existing bounded regular file, preserves it and prints no RPC secrets or transaction bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'order-read-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'order.json'), h = harness(); const content = JSON.stringify(h.initial());
  await writeFile(file, content, { mode: 0o600 }); let output = '';
  const options = { env: { COOLBEARS_BUYER_RPC_URL: endpoint }, fetchImpl: h.fetchImpl, output: { write: text => { output += text; } } };
  assert.equal(await runOrderCheck(['preflight', file], options), 0);
  assert.equal(JSON.parse(output).status, 'preflight-passed');
  assert.doesNotMatch(output, /SECRET-FIXTURE|transactionBase64|order-fixture\.test|\/tmp\//);
  assert.equal(await readFile(file, 'utf8'), content);
  const link = path.join(directory, 'alias'); await symlink(file, link); output = '';
  assert.equal(await runOrderCheck(['preflight', link], options), 1);
  assert.equal(JSON.parse(output).networkRequests, 0);
});
test('429 and hung transport are bounded, sanitized and never retried', async () => {
  let calls = 0;
  const blocked = await preflightOrder({ readOrder: () => order(), endpoint, fetchImpl: () => { calls++; return new Response('SECRET-FIXTURE', { status: 429 }); } });
  assert.equal(blocked.code, 'RPC_HTTP'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(blocked), /SECRET/);
  const timed = await preflightOrder({ readOrder: () => order(), endpoint, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(timed.code, 'RPC_TIMEOUT'); assert.equal(timed.networkRequests, 1);
});
