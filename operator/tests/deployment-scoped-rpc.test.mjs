// Synthetic accounts and disposable signing keys only. No live RPC.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { createScopedDeploymentRpc } from '../deployment/scoped-rpc.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';

const key = n => Keypair.fromSeed(createHash('sha256').update(`scoped-rpc-fixture:${n}`).digest());
const owner = key('owner'), collection = key('collection'), asset = key('asset'), machine = key('machine');
const hash = key('hash').publicKey.toBase58(), freshHash = key('fresh').publicKey.toBase58();
const endpoint = 'https://rpc-fixture.example/?api-key=PRIVATE_SENTINEL';
const encode = tx => Buffer.from(tx.serialize()).toString('base64');
const decode = text => VersionedTransaction.deserialize(Buffer.from(text, 'base64'));
const fee = tx => [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'confirmed', minContextSlot: 9 }];
const simulation = (tx, signed = false) => [encode(tx), { encoding: 'base64', commitment: 'confirmed',
  sigVerify: signed, replaceRecentBlockhash: false, minContextSlot: 9 }];
const safe = code => error => {
  assert.equal(error.code, code);
  assert.ok(!JSON.stringify(error).includes('PRIVATE_SENTINEL'));
  assert.ok(!String(error).includes('https://'));
  return true;
};
let manifest, plan, originalOwner, originalFetch;
before(async () => {
  originalOwner = policy.owner; originalFetch = globalThis.fetch;
  policy.owner = owner.publicKey.toBase58();
  globalThis.fetch = () => assert.fail('Live network forbidden');
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
    reservedAsset: asset.publicKey.toBase58(), machine: machine.publicKey.toBase58(), blockhash: hash,
    lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
  manifest = deploymentManifestFromPlan('scoped-rpc-fixture', plan);
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
async function harness(options = {}, respond = () => null) {
  const calls = [];
  const rpc = await createScopedDeploymentRpc({ manifest, endpoint, ...options, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const result = request.method === 'getGenesisHash' ? GENESIS_HASHES.devnet : await respond(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  return { rpc, calls };
}

test('construction is offline and all 1431 canonical fee templates accept a fresh blockhash', async () => {
  const { rpc, calls } = await harness({}, () => ({ context: { slot: 9 }, value: 10000 }));
  assert.equal(calls.length, 0); assert.equal(rpc.networkVerified, false);
  assert.equal(rpc.readyToSubmit, false); assert.equal(rpc.salesOpen, false);
  for (const step of plan.steps) {
    const tx = decode(step.transactionBase64); tx.message.recentBlockhash = freshHash;
    assert.equal((await rpc.call('getFeeForMessage', fee(tx))).value, 10000);
  }
  assert.equal(calls.length, 1432); assert.equal(calls[0].method, 'getGenesisHash');
  assert.equal(calls.filter(call => call.method === 'getGenesisHash').length, 1);
  assert.equal(rpc.networkVerified, true);
});

test('full machine and exact account set fit the bounded response', async () => {
  const addresses = ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
    'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J', 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
    plan.roles.collection, plan.roles.reservedAsset, plan.roles.machine, plan.roles.guard];
  const result = { context: { slot: 9 }, value: [null, null, null, null, null,
    { data: [Buffer.alloc(plan.machineSpace).toString('base64'), 'base64'] }, null] };
  const { rpc, calls } = await harness({}, () => result);
  const params = [addresses, { encoding: 'base64', commitment: 'finalized', minContextSlot: 9 }];
  assert.deepEqual(await rpc.call('getMultipleAccounts', params), result);
  assert.equal(rpc.maxResponseBytes, 4194304);
  params[0][3] = owner.publicKey.toBase58();
  await assert.rejects(rpc.call('getMultipleAccounts', params), safe('PARAMS'));
  await assert.rejects(rpc.call('getBalance', [collection.publicKey.toBase58(), { commitment: 'finalized' }]), safe('PARAMS'));
  await assert.rejects(rpc.call('getMinimumBalanceForRentExemption', [10000000, { commitment: 'finalized' }]), safe('PARAMS'));
  assert.equal(calls.length, 2);
});

test('changed instructions, signer, account, options and writes are refused before any network request', async () => {
  const { rpc, calls } = await harness();
  for (const mutate of [tx => { tx.message.compiledInstructions[0].data[0] ^= 1; },
    tx => { tx.message.staticAccountKeys[0] = key('stranger').publicKey; },
    tx => { tx.message.header.numReadonlyUnsignedAccounts++; },
    tx => { tx.message.addressTableLookups.push({ accountKey: key('lookup').publicKey, writableIndexes: [0], readonlyIndexes: [] }); }]) {
    const tx = decode(plan.steps[0].transactionBase64); mutate(tx);
    await assert.rejects(rpc.call('getFeeForMessage', fee(tx)), safe('PARAMS'));
  }
  for (const method of ['sendTransaction', 'sendRawTransaction', 'requestAirdrop', 'getProgramAccounts', 'getAsset', ['getGenesisHash']])
    await assert.rejects(rpc.call(method, []), safe('METHOD'));
  await assert.rejects(rpc.call('simulateTransaction', simulation(decode(plan.steps[0].transactionBase64))), safe('METHOD'));
  for (const input of [null, [undefined], [Infinity], ['PRIVATE_SENTINEL'.repeat(1000)]])
    await assert.rejects(rpc.call('getGenesisHash', input), safe('PARAMS'));
  const malformed = fee(decode(plan.steps[0].transactionBase64)); malformed[0] += '\n';
  await assert.rejects(rpc.call('getFeeForMessage', malformed), safe('PARAMS'));
  assert.equal(calls.length, 0);
});

test('unsigned, partially signed and fully signed simulations preserve bytes and verify signatures', async () => {
  const { rpc, calls } = await harness({ allowSimulation: true }, () => ({ context: { slot: 9 }, value: { err: null } }));
  const tx = decode(plan.steps[0].transactionBase64); tx.message.recentBlockhash = freshHash;
  await rpc.call('simulateTransaction', simulation(tx));
  tx.sign([collection]); await rpc.call('simulateTransaction', simulation(tx));
  await assert.rejects(rpc.call('simulateTransaction', simulation(tx, true)), safe('PARAMS'));
  tx.sign([owner]); await rpc.call('simulateTransaction', simulation(tx, true));
  assert.equal(calls.at(-1).params[0], encode(tx));
  await assert.rejects(rpc.call('simulateTransaction', simulation(tx)), safe('PARAMS'));
  const badOptions = simulation(tx, true); badOptions[1].replaceRecentBlockhash = true;
  await assert.rejects(rpc.call('simulateTransaction', badOptions), safe('PARAMS'));
  tx.signatures[1][0] ^= 1;
  await assert.rejects(rpc.call('simulateTransaction', simulation(tx, true)), safe('PARAMS'));
  assert.equal(calls.length, 4);
});

test('recovery only reads the immutable signature list and does not treat null as proof', async () => {
  const tx = decode(plan.steps[0].transactionBase64); tx.sign([owner, collection]);
  const sig = base58.deserialize(tx.signatures[0])[0], allowed = [sig];
  const { rpc, calls } = await harness({ recoverySignatures: allowed });
  const other = base58.deserialize(new Uint8Array(64).fill(42))[0]; allowed.push(other);
  assert.equal(await rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]), null);
  assert.equal(await rpc.call('getTransaction', [sig, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]), null);
  await assert.rejects(rpc.call('getSignatureStatuses', [[other], { searchTransactionHistory: true }]), safe('PARAMS'));
  assert.equal(calls.length, 3);
});

test('wrong network and HTTP 429 stop without fallback or a hidden retry', async () => {
  for (const mode of ['wrong-genesis', '429']) {
    let calls = 0;
    const rpc = await createScopedDeploymentRpc({ manifest, endpoint, fetchImpl: async (_url, init) => {
      calls++; const request = JSON.parse(init.body);
      return mode === '429' ? new Response('', { status: 429 }) : new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: GENESIS_HASHES['mainnet-beta'] }));
    } });
    await assert.rejects(rpc.call('getBalance', [plan.roles.owner, { commitment: 'finalized' }]), safe(mode === '429' ? 'HTTP' : 'GENESIS'));
    assert.equal(calls, 1); assert.equal(rpc.networkVerified, false);
  }
});

test('concurrent first reads share one genesis check and snapshot their parameters', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const rpc = await createScopedDeploymentRpc({ manifest, endpoint, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    if (request.method === 'getGenesisHash') await gate;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'getGenesisHash' ? GENESIS_HASHES.devnet : null }));
  } });
  const params = [plan.roles.owner, { commitment: 'finalized' }];
  const reads = [rpc.call('getBalance', params), rpc.call('getBalance', params)];
  params[0] = key('changed').publicKey.toBase58(); release();
  await Promise.all(reads);
  assert.equal(calls.length, 3); assert.equal(calls[1].params[0], plan.roles.owner);
});

test('noncanonical manifest and mainnet configuration fail before network', async () => {
  const changed = structuredClone(manifest); changed.steps[0].expected.uri = 'https://PRIVATE_SENTINEL.invalid';
  await assert.rejects(createScopedDeploymentRpc({ manifest: changed, endpoint }), safe('DEPLOYMENT_INTENT_INVALID'));
  const mainnet = structuredClone(manifest); mainnet.cluster = 'mainnet-beta';
  await assert.rejects(createScopedDeploymentRpc({ manifest: mainnet, endpoint }), safe('CLUSTER'));
});
