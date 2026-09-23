import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { makeGateway } from '../deployment/gateway/worker.mjs';
import { createGatewayFetch } from '../deployment/gateway/client.mjs';
// Real SDK bytes, local journals and real TEST-key signatures. Every network
// response, rent rate and balance is synthetic; never report these as live SOL.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction, VersionedMessage } from '@solana/web3.js';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginSerializer, getPluginHeaderV1AccountDataSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { buildDeploymentCostModel } from '../deployment/cost-model.mjs';
import { createSigningRequest } from '../deployment/signing.mjs';
import { createDeploymentJournal, readDeploymentJournal, appendDeploymentEvent, sha256Json } from '../deployment/journal.mjs';
import { GENESIS_HASHES, createDeploymentRpc } from '../deployment/rpc.mjs';

const key = n => Keypair.fromSeed(createHash('sha256').update(`budget-simulation-fixture:${n}`).digest());
const owner = key('owner'), collection = key('collection'), reserve = key('reserve'), machine = key('machine');
const oldHash = key('old-hash').publicKey.toBase58(), freshHash = key('fresh-hash').publicKey.toBase58();
const endpoint = 'https://rpc-fixture.example/?api-key=PRIVATE_SENTINEL';
const rent = bytes => 3000 + bytes * 11; // Intentionally NOT a Solana rent schedule.
const encode = tx => Buffer.from(tx.serialize()).toString('base64');
const decode = bytes => VersionedTransaction.deserialize(Buffer.from(bytes, 'base64'));
let plan, manifest, model, originalOwner, originalFetch, quoteDeploymentBudget, formatSol, simulateDeploymentStep, liveCalls = 0;

before(async () => {
  originalOwner = policy.owner; originalFetch = globalThis.fetch;
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  // The account verifier captures the fixed policy on import. Install this
  // worker's test owner first, as in the existing read/handoff integration tests.
  ({ quoteDeploymentBudget, formatSol } = await import('../deployment/budget.mjs'));
  ({ simulateDeploymentStep } = await import('../deployment/simulation.mjs'));
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
    reservedAsset: reserve.publicKey.toBase58(), machine: machine.publicKey.toBase58(), blockhash: oldHash,
    lastValidBlockHeight: 1000, machineRentLamports: String(rent(871827)) });
  manifest = deploymentManifestFromPlan('budget-simulation-fixture', plan);
  ({ model } = await buildDeploymentCostModel(manifest));
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

function collectionAccount() {
  const e = plan.steps[0].expected;
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1,
    updateAuthority: policy.owner, name: e.name, uri: e.uri, numMinted: 0, currentSize: 0 });
  const plugin = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{ basisPoints: 700,
    creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] });
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: base.length + 9 + plugin.length });
  const registry = getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1,
    registry: [{ pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset: base.length + 9 }], externalRegistry: [] });
  const data = Buffer.concat([base, header, plugin, registry]);
  return { data: [data.toString('base64'), 'base64'], owner: MPL_CORE_PROGRAM_ID, executable: false, lamports: rent(data.length), space: data.length, rentEpoch: 0 };
}
async function harness(t, custom = manifest) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-budget-simulation-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'journal');
  await createDeploymentJournal(directory, custom);
  const h = { directory, snapshot: () => readDeploymentJournal(directory) };
  h.append = async (type, fields = {}) => {
    const snapshot = await h.snapshot();
    return appendDeploymentEvent(directory, { type, stepId: 'collection-create', ...(type === 'prepare' ? {} : { attempt: 1 }), ...fields }, { expectedRevision: snapshot.revision });
  };
  h.prepare = async () => {
    const tx = decode(manifest.steps[0].transactionBase64); tx.message.recentBlockhash = freshHash; tx.sign([collection]);
    const request = createSigningRequest({ deploymentId: manifest.id, stepId: 'collection-create', attempt: 1,
      cluster: 'devnet', owner: policy.owner, transactionBase64: encode(tx), lastValidBlockHeight: 2000 });
    await h.append('prepare', { request, retry: false }); return request;
  };
  h.sign = async () => {
    const request = await h.prepare(), tx = decode(request.transactionBase64); tx.sign([owner]);
    await h.append('signed', { transactionBase64: encode(tx) });
    return (await h.snapshot()).steps[0].attempts[0];
  };
  h.settle = async (kind = 'verified') => {
    const attempt = await h.sign();
    await h.append('claim-send'); await h.append('accepted');
    const snapshot = await h.snapshot();
    const proof = { kind, manifestSha256: snapshot.manifestSha256, stepId: 'collection-create', attempt: 1,
      messageSha256: attempt.request.messageSha256, signature: attempt.signed.signature, commitment: 'finalized',
      slot: 450, readSlot: 451, expectedSha256: sha256Json(plan.steps[0].expected),
      ...(kind === 'verified' ? { transactionSucceeded: true, expectedStateVerified: true } : { executionFailed: true, effectsAbsent: true }) };
    await h.append('reconcile', { proof }); return (await h.snapshot()).steps[0].attempts[0];
  };
  return h;
}
function fixture({ override = {}, onCall, completed = false, receipt } = {}) {
  const calls = [], fees = [];
  return { calls, fees, fetchImpl: async (url, options) => {
    assert.equal(url, endpoint); const request = JSON.parse(options.body); calls.push(request);
    assert.ok(!/send|airdrop/i.test(request.method));
    const slot = 500 + calls.length;
    let result;
    switch (request.method) {
      case 'getGenesisHash': result = GENESIS_HASHES.devnet; break;
      case 'getMultipleAccounts': result = { context: { slot }, value: [ { executable: true }, { executable: true }, { executable: true }, completed ? collectionAccount() : null, null, null, null ] }; break;
      case 'getMinimumBalanceForRentExemption': result = rent(request.params[0]); break;
      case 'getLatestBlockhash': result = { context: { slot }, value: { blockhash: freshHash, lastValidBlockHeight: 2000 } }; break;
      case 'getFeeForMessage': {
        const bytes = Buffer.from(request.params[0], 'base64'), message = VersionedMessage.deserialize(bytes);
        const fee = message.header.numRequiredSignatures * 5000 + bytes.length;
        fees.push(fee); result = { context: { slot }, value: fee }; break;
      }
      case 'getBalance': result = { context: { slot }, value: 10000000000 }; break;
      case 'isBlockhashValid': result = { context: { slot }, value: true }; break;
      case 'getBlockHeight': result = 1500; break;
      case 'simulateTransaction': result = { context: { slot }, value: { err: null, unitsConsumed: 13579, logs: ['PRIVATE_SENTINEL'], returnData: { data: 'PRIVATE_SENTINEL' } } }; break;
      case 'getSignatureStatuses': result = { context: { slot }, value: [{ slot: 450, confirmations: null,
        confirmationStatus: 'finalized', err: receipt?.state === 'failed' ? { InstructionError: [0, { Custom: 1 }] } : null }] }; break;
      case 'getTransaction': {
        if (!receipt) { result = null; break; }
        const count = decode(receipt.signed.transactionBase64).message.staticAccountKeys.length;
        result = { slot: 450, version: 0, transaction: [receipt.signed.transactionBase64, 'base64'], meta: {
          err: receipt.state === 'failed' ? { InstructionError: [0, { Custom: 1 }] } : null,
          fee: 12345, preBalances: Array(count).fill(1000000), postBalances: Array(count).fill(1000000) } };
        result.meta.postBalances[0] -= 12345 + (receipt.state === 'verified' ? 54321 : 0); break;
      }
      default: assert.fail(`Unexpected read ${request.method}`);
    }
    if (Object.hasOwn(override, request.method)) result = typeof override[request.method] === 'function'
      ? await override[request.method](result, request) : override[request.method];
    await onCall?.(request, result);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } };
}
const quote = (h, rpc, extra = {}) => quoteDeploymentBudget({ directory: h.directory, endpoint, fetchImpl: rpc.fetchImpl, ...extra });
const simulate = (h, rpc, mode = 'unsigned', extra = {}) => simulateDeploymentStep({ directory: h.directory,
  stepId: 'collection-create', mode, endpoint, fetchImpl: rpc.fetchImpl, ...extra });
function safe(result) {
  for (const name of ['readyToSubmit', 'salesOpen']) assert.equal(result[name], false);
  assert.equal(result.transactionsSent, 0); assert.equal(result.journalWrites, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
}

test('source-backed layout includes royalties, inherited collection, delegate growth and guard data', () => {
  assert.deepEqual(model.sizes, { collection: 178, reservedAsset: 158, machine: 871827, guard: 157, collectionWithDelegate: 225 });
  assert.equal(model.sizes.collectionWithDelegate - model.sizes.collection, 47);
  assert.equal(model.steps.length, 1431); assert.equal(model.requiredSignatures, 1434);
  assert.deepEqual(model.protocolItems, [{ id: 'reserve-core-create-fee', stepId: 'reserve-create', lamports: '1500000' }]);
  assert.equal(model.priorityFeeLamports, '0'); assert.equal(model.buyerMintsIncluded, 0);
});

test('complete per-message estimate accounts for all 1431 fees and isolates buffer/retries', async t => {
  const h = await harness(t), before = await h.snapshot(), rpc = fixture();
  const result = await quote(h, rpc); safe(result); assert.equal(result.status, 'budget-estimated');
  assert.equal(rpc.fees.length, 1431); assert.equal(new Set(result.steps.map(step => step.messageSha256)).size, 1431);
  for (const call of rpc.calls.filter(call => call.method === 'getFeeForMessage')) {
    assert.equal(VersionedMessage.deserialize(Buffer.from(call.params[0], 'base64')).recentBlockhash, freshHash);
    assert.equal(call.params[1].commitment, 'confirmed');
  }
  const expectedRent = rent(225) + rent(158) + rent(871827) + rent(157);
  const expectedFees = rpc.fees.reduce((a, b) => a + b, 0), total = expectedRent + expectedFees + 1500000;
  assert.equal(result.estimates.accountRentLamports, String(expectedRent));
  assert.equal(result.estimates.networkFeesLamports, String(expectedFees));
  assert.equal(result.estimates.fullDeploymentLamports, String(total));
  assert.equal(result.estimates.remainingLamports, String(total));
  assert.equal(result.estimates.bufferLamports, String(Math.ceil(total / 10)));
  assert.equal(result.estimates.retryFeeAllowanceLamports, String(Math.max(...rpc.fees) * 10));
  assert.equal(result.incurred.verifiedOwnerDebitLamports, '0');
  assert.equal(result.budgetComplete, false); assert.equal(result.modelComplete, true); assert.equal(result.quotesComplete, true);
  assert.equal(result.fundingRecommendationLamports, null); assert.deepEqual(await h.snapshot(), before);
});

test('incurred costs come from exact finalized receipts, not today’s rent or fee quotes', async t => {
  const h = await harness(t), receipt = await h.settle(), rpc = fixture({ completed: true, receipt });
  const result = await quote(h, rpc, { bufferBasisPoints: 0, retryTransactions: 0 }); safe(result);
  assert.equal(result.status, 'budget-estimated'); assert.equal(result.estimates.remainingSteps, 1430);
  assert.equal(result.incurred.verifiedOwnerDebitLamports, '66666'); assert.equal(result.incurred.verifiedNetworkFeesLamports, '12345');
  assert.equal(BigInt(result.estimates.fullDeploymentLamports) - BigInt(result.estimates.remainingLamports), BigInt(result.steps[0].estimatedLamports));
  assert.equal(result.estimates.bufferLamports, '0'); assert.equal(result.estimates.retryFeeAllowanceLamports, '0');
});

test('finalized failed fees are incurred, while the whole failed step remains in the estimate', async t => {
  const h = await harness(t), receipt = await h.settle('failed'), rpc = fixture({ receipt });
  const result = await quote(h, rpc); safe(result); assert.equal(result.status, 'budget-estimated');
  assert.equal(result.incurred.verifiedOwnerDebitLamports, '12345'); assert.equal(result.estimates.remainingSteps, 1431);
});

test('historical failed fees remain readable after a new attempt is prepared', async t => {
  const h = await harness(t), receipt = await h.settle('failed');
  const tx = decode(manifest.steps[0].transactionBase64);
  tx.message.recentBlockhash = key('second-attempt').publicKey.toBase58(); tx.sign([collection]);
  const request = createSigningRequest({ deploymentId: manifest.id, stepId: 'collection-create', attempt: 2,
    cluster: 'devnet', owner: policy.owner, transactionBase64: encode(tx), lastValidBlockHeight: 3000 });
  await h.append('prepare', { request, retry: true });
  const before = await h.snapshot(), rpc = fixture({ receipt }), result = await quote(h, rpc);
  assert.equal(result.status, 'budget-estimated');
  assert.equal(result.incurred.verifiedOwnerDebitLamports, '12345');
  assert.equal(result.incurred.receipts[0].attempt, 1);
  assert.deepEqual(await h.snapshot(), before);
});

test('missing actual receipt cannot be silently treated as zero spent', async t => {
  const h = await harness(t), receipt = await h.settle(), rpc = fixture({ completed: true, receipt, override: { getTransaction: null } });
  const result = await quote(h, rpc); safe(result); assert.equal(result.status, 'blocked'); assert.equal(result.phase, 'spent');
});

test('rent drift, null fee and mismatched network prevent a complete quote', async t => {
  const h = await harness(t);
  for (const [override, code] of [
    [{ getMinimumBalanceForRentExemption: value => value + 1 }, 'MACHINE_RENT_CHANGED_REBUILD_PLAN'],
    [{ getFeeForMessage: value => ({ ...value, value: null }) }, 'FEE_QUOTE_UNAVAILABLE'],
    [{ getGenesisHash: GENESIS_HASHES['mainnet-beta'] }, 'RPC_GENESIS'],
  ]) {
    const result = await quote(h, fixture({ override })); safe(result); assert.equal(result.status, 'blocked');
    assert.equal(result.code, code); assert.equal(result.quotesComplete, false);
  }
});

test('expired quote blockhash and stale fee context are refused', async t => {
  const h = await harness(t);
  for (const [override, code] of [
    [{ isBlockhashValid: value => ({ ...value, value: false }) }, 'BUDGET_BLOCKHASH_EXPIRED'],
    [{ getBlockHeight: 2000 }, 'BUDGET_BLOCK_HEIGHT_EXPIRED'],
    [{ getFeeForMessage: value => ({ ...value, context: { slot: 1 } }) }, 'INVALID_RPC_CONTEXT'],
  ]) assert.equal((await quote(h, fixture({ override }))).code, code);
});

test('journal changes invalidate the entire budget and a claim requires reconciliation', async t => {
  const h = await harness(t); let changed = false;
  const rpc = fixture({ onCall: async request => {
    if (request.method === 'getFeeForMessage' && !changed) { changed = true; await h.prepare(); }
  } });
  const result = await quote(h, rpc); safe(result); assert.equal(result.code, 'JOURNAL_CHANGED_DURING_READ');
  const tx = decode((await h.snapshot()).steps[0].attempts[0].request.transactionBase64); tx.sign([owner]);
  await h.append('signed', { transactionBase64: encode(tx) }); await h.append('claim-send');
  const unused = fixture(); assert.equal((await quote(h, unused)).code, 'RECONCILIATION_REQUIRED'); assert.equal(unused.calls.length, 0);
});

test('budget options are bounded and decimal SOL formatting is exact', async t => {
  const h = await harness(t), rpc = fixture();
  for (const extra of [{ concurrency: 0 }, { concurrency: 17 }, { bufferBasisPoints: -1 }, { retryTransactions: 0.5 }]) {
    assert.equal((await quote(h, rpc, extra)).code, 'INVALID_BUDGET_OPTIONS');
  }
  assert.equal(rpc.calls.length, 0); assert.equal(formatSol('1'), '0.000000001'); assert.equal(formatSol('9999999999999999'), '9999999.999999999');
});

test('unsigned simulation uses the fresh exact preflight candidate without journal changes', async t => {
  const h = await harness(t), before = await h.snapshot(), rpc = fixture();
  const result = await simulate(h, rpc); safe(result); assert.equal(result.status, 'simulation-passed');
  assert.equal(result.simulationVerified, true); assert.equal(result.signaturesVerified, false);
  const call = rpc.calls.find(call => call.method === 'simulateTransaction');
  assert.equal(call.params[0], result.candidate.transactionBase64);
  assert.equal(call.params[1].replaceRecentBlockhash, false); assert.equal(call.params[1].sigVerify, false);
  assert.ok(decode(call.params[0]).signatures.every(sig => sig.every(byte => byte === 0)));
  assert.equal(result.candidate.blockhash, freshHash); assert.deepEqual(await h.snapshot(), before);
  assert.ok(!('logs' in result)); assert.equal(result.unitsConsumed, 13579);
});

test('saved partial and fully signed modes preserve every byte; signed mode verifies all signatures', async t => {
  const h = await harness(t), request = await h.prepare(), unsigned = fixture();
  const partial = await simulate(h, unsigned); assert.equal(partial.status, 'simulation-passed');
  assert.equal(partial.candidate.transactionBase64, request.transactionBase64);
  assert.ok(!unsigned.calls.some(call => call.method === 'getLatestBlockhash'));
  const tx = decode(request.transactionBase64); tx.sign([owner]); await h.append('signed', { transactionBase64: encode(tx) });
  const before = await h.snapshot(), rpc = fixture(), signed = await simulate(h, rpc, 'signed'); safe(signed);
  assert.equal(signed.status, 'simulation-passed'); assert.equal(signed.signaturesVerified, true);
  const call = rpc.calls.find(call => call.method === 'simulateTransaction');
  assert.equal(call.params[0], encode(tx)); assert.equal(call.params[1].sigVerify, true);
  assert.equal(call.params[1].replaceRecentBlockhash, false); assert.deepEqual(await h.snapshot(), before);
});

test('explicit mode and saved owner signature are required before signed simulation RPC', async t => {
  const h = await harness(t), rpc = fixture();
  assert.equal((await simulate(h, rpc, 'signed')).code, 'SAVED_SIGNED_ATTEMPT_REQUIRED');
  assert.equal((await simulate(h, rpc, 'typo')).code, 'EXPLICIT_SIMULATION_MODE_REQUIRED');
  await h.sign(); assert.equal((await simulate(h, rpc, 'unsigned')).code, 'UNSIGNED_MODE_HAS_OWNER_SIGNATURE');
  assert.equal(rpc.calls.length, 0);
});

test('execution errors, replacement blockhash, stale contexts and missing simulation fields fail closed', async t => {
  const h = await harness(t);
  for (const [replace, code] of [
    [value => ({ ...value, value: { err: 'PRIVATE_SENTINEL', unitsConsumed: 1 } }), 'SIMULATION_EXECUTION_FAILED'],
    [value => ({ ...value, value: { ...value.value, replacementBlockhash: { blockhash: oldHash } } }), 'SIMULATION_REPLACED_BLOCKHASH'],
    [value => ({ ...value, context: { slot: 1 } }), 'INVALID_RPC_CONTEXT'],
    [value => ({ ...value, value: { unitsConsumed: 1 } }), 'INVALID_SIMULATION_RESULT'],
    [value => ({ ...value, value: { err: null, unitsConsumed: -1 } }), 'INVALID_SIMULATION_UNITS'],
  ]) {
    const result = await simulate(h, fixture({ override: { simulateTransaction: replace } })); safe(result);
    assert.equal(result.status, 'blocked'); assert.equal(result.simulationVerified, false); assert.equal(result.code, code);
  }
});

test('expiry after simulation and journal mutation during simulation invalidate success', async t => {
  const h = await harness(t); let simulated = false;
  const rpc = fixture({ onCall: request => { if (request.method === 'simulateTransaction') simulated = true; },
    override: { getBlockHeight: () => simulated ? 2000 : 1500 } });
  assert.equal((await simulate(h, rpc)).code, 'BLOCK_HEIGHT_NOT_USABLE');
  const changing = fixture({ onCall: async request => { if (request.method === 'simulateTransaction') await h.prepare(); } });
  assert.equal((await simulate(h, changing)).code, 'JOURNAL_CHANGED_DURING_READ');
});

test('simulation opt-in cannot enable broadcasts or message-changing flags', async () => {
  const rpc = createDeploymentRpc({ endpoint, allowSimulation: true, fetchImpl: () => assert.fail('No network expected') });
  await assert.rejects(rpc.call('sendTransaction', []), error => error.code === 'METHOD');
  const config = { encoding: 'base64', commitment: 'confirmed', sigVerify: false, minContextSlot: 1, replaceRecentBlockhash: false };
  for (const extra of [{ replaceRecentBlockhash: true }, { logs: true }, { sigVerify: 'false' }, { minContextSlot: -1 }]) {
    await assert.rejects(rpc.call('simulateTransaction', ['AA==', { ...config, ...extra }]), error => error.code === 'PARAMS');
  }
});


test('full budget crosses 15 paced gateway windows with fresh hashes and unchanged journal', async t => {
  const h = await harness(t), before = await h.snapshot();
  let window = 0, currentHash, now = 1800000000000;
  const rpc = fixture({ override: {
    getLatestBlockhash: value => {
      currentHash = Keypair.fromSeed(createHash('sha256').update(`budget-window-${++window}`).digest()).publicKey.toBase58();
      return { ...value, value: { ...value.value, blockhash: currentHash } };
    },
    getFeeForMessage: (value, request) => {
      assert.equal(VersionedMessage.deserialize(Buffer.from(request.params[0], 'base64')).recentBlockhash, currentHash);
      return value;
    },
    isBlockhashValid: (value, request) => { assert.equal(request.params[0], currentHash); return value; },
  } });
  const values = new Map(), storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); }, async transaction(fn) { return fn(this); } };
  const compiled = await compileDeploymentRpcPolicy(before.manifest);
  const { worker, DeploymentGate } = makeGateway(compiled), token = 'B'.repeat(43);
  const env = { OPERATOR_RPC_TOKEN: token, HELIUS_API_KEY: 'budget-fixture-only' };
  const gate = new DeploymentGate({ storage }, env, { clock: () => now, pause: async ms => { now += ms; },
    fetchImpl: (_url, init) => rpc.fetchImpl(endpoint, init) });
  env.DEPLOYMENT_GATE = { idFromName: name => name, get: () => gate };
  const gatewayEndpoint = 'https://budget-operator.test/rpc';
  const fetchImpl = createGatewayFetch({ endpoint: gatewayEndpoint, token,
    fetchImpl: (url, init) => worker.fetch(new Request(url, init), env) });
  const result = await quoteDeploymentBudget({ directory: h.directory, endpoint: gatewayEndpoint, fetchImpl });
  safe(result); assert.equal(result.status, 'budget-estimated');
  assert.equal(result.quoteWindows.length, 15); assert.equal(new Set(result.quoteWindows.map(item => item.blockhash)).size, 15);
  assert.equal(result.quoteWindows.reduce((sum, item) => sum + item.count, 0), 1431);
  assert.equal(rpc.fees.length, 1431); assert.ok(now - 1800000000000 > 280000);
  assert.equal([...values.values()][0].used, rpc.calls.length);
  assert.deepEqual(await h.snapshot(), before);
});
