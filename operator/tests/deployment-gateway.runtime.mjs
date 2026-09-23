// Real workerd + SQLite, synthetic plan and intercepted HTTP only. Never deploys.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy as approved } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { inspectSignedDeploymentTransaction } from '../deployment/signing.mjs';
const key = n => Keypair.fromSeed(createHash('sha256').update(`gateway-runtime-${n}`).digest());
const owner = key('owner'), collection = key('collection');
const savedOwner = approved.owner; approved.owner = owner.publicKey.toBase58();
const plan = await buildDeploymentPlan({ cluster: 'devnet', collection: collection.publicKey.toBase58(),
  reservedAsset: key('asset').publicKey.toBase58(), machine: key('machine').publicKey.toBase58(),
  blockhash: key('hash').publicKey.toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
const policy = await compileDeploymentRpcPolicy(deploymentManifestFromPlan('runtime-gateway-fixture', plan), { allowSimulation: true });
approved.owner = savedOwner;
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const bundled = await build({ stdin: { contents: `import { makeGateway } from './operator/deployment/gateway/worker.mjs';
const { worker, DeploymentGate } = makeGateway(${JSON.stringify(policy)}, { allowSubmission: true });
export { DeploymentGate }; export default worker;`, resolveDir: root, sourcefile: 'gateway-fixture.mjs' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['node:*'] });
const contents = bundled.outputFiles[0].text;
// Full SDK/CLI builders must not enter the private Worker bundle.
assert.ok(!contents.includes('buildDeploymentCostModel')); assert.ok(!contents.includes('validateCanonicalDeploymentManifest'));
const persist = await mkdtemp(path.join(tmpdir(), 'coolbears-operator-runtime-'));
const name = 'coolbears-deployment-rpc-runtime', endpoint = 'https://private-operator.test/rpc';
const token = 'W'.repeat(43), secret = 'runtime-private-sentinel', calls = [], errors = [];
let mf, mode = 'normal', sendPhase = false, failedBytes, expiryHash, fundingSignature;
async function outbound(request) {
  const url = new URL(request.url); assert.equal(url.hostname, 'devnet.helius-rpc.com');
  assert.equal(url.searchParams.get('api-key'), secret); assert.equal(request.headers.has('authorization'), false);
  const rpc = await request.json(); calls.push({ method: rpc.method, at: Date.now() });
  assert.ok(['getGenesisHash', 'getMultipleAccounts', 'getFeeForMessage', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getTransaction',
    'getLatestBlockhash', 'getBlock', 'isBlockhashValid', 'getFirstAvailableBlock', 'getSignaturesForAddress'].includes(rpc.method));
  if (mode === '429') return new RuntimeResponse(secret, { status: 429, headers: { 'retry-after': '5' } });
  if (mode === 'send-lost' && rpc.method === 'sendTransaction') return new RuntimeResponse(secret, { status: 503 });
  let result;
  if (rpc.method === 'getGenesisHash') result = GENESIS_HASHES.devnet;
  if (rpc.method === 'getMultipleAccounts') result = { context: { slot: 9 }, value: [null, null, null, null, null,
    { data: [Buffer.alloc(plan.machineSpace).toString('base64'), 'base64'] }, null] };
  if (rpc.method === 'getFeeForMessage') result = { context: { slot: 9 }, value: 10000 };
  if (rpc.method === 'simulateTransaction') result = { context: { slot: 9 }, value: { err: null, logs: [], unitsConsumed: 1 } };
  if (rpc.method === 'sendTransaction') result = inspectSignedDeploymentTransaction(rpc.params[0]).signature;
  if (['getSignatureStatuses', 'getTransaction'].includes(rpc.method)) result = null;
  if (mode === 'failed') {
    const err = { InstructionError: [0, 'InvalidArgument'] };
    if (rpc.method === 'getSignatureStatuses') result = { context: { slot: 600 }, value: [{ slot: 590, confirmations: null, confirmationStatus: 'finalized', err }] };
    if (rpc.method === 'getTransaction') result = { slot: 590, version: 0, meta: { err }, transaction: [failedBytes, 'base64'] };
  }
  if (mode === 'expiry') {
    if (rpc.method === 'getLatestBlockhash') result = { context: { slot: 1000 }, value: { blockhash: expiryHash, lastValidBlockHeight: 850 } };
    if (rpc.method === 'getBlock') result = { blockhash: rpc.params[0] === 1000 ? expiryHash : key('horizon').publicKey.toBase58(),
      blockHeight: rpc.params[0] === 1000 ? 700 : 900, parentSlot: rpc.params[0] - 1 };
    if (rpc.method === 'isBlockhashValid') result = { context: { slot: 1200 }, value: false };
    if (rpc.method === 'getFirstAvailableBlock') result = 800;
    if (rpc.method === 'getSignatureStatuses') result = { context: { slot: 1300 }, value: [null] };
    if (rpc.method === 'getSignaturesForAddress') result = [{ signature: fundingSignature, slot: 999, confirmationStatus: 'finalized', err: null }];
  }
  return new RuntimeResponse(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
}
async function start() {
  mf = new Miniflare({ telemetry: { enabled: false }, cf: false, logRequests: false, resourcePersistencePath: persist,
    handleUncaughtError: error => errors.push(error.message), workers: [{ config: {
      name, compatibilityDate: '2026-09-23', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents } } },
      env: { OPERATOR_RPC_TOKEN: { type: 'text', value: token }, HELIUS_API_KEY: { type: 'text', value: secret },
        DAILY_CREDIT_CAP: { type: 'text', value: sendPhase ? '80' : '7' }, DAILY_SIMULATION_CAP: { type: 'text', value: '1' },
        DEPLOYMENT_GATE: { type: 'durable-object', worker: name, exportName: 'DeploymentGate' } },
      exports: { DeploymentGate: { type: 'durable-object', storage: 'sqlite' } },
    }, dev: { outboundService: { type: 'fetcher', handler: outbound } } }] });
  await mf.ready;
}
function dispatch(method = 'getGenesisHash', params = [], extraHeaders = {}) {
  return mf.dispatchFetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
}
let cases = 0;
try {
  await start();
  assert.equal((await dispatch('getGenesisHash', [], { authorization: '' })).status, 401);
  assert.equal((await dispatch('getGenesisHash', [], { origin: 'https://coolbears-nfts.com' })).status, 403);
  assert.equal((await dispatch('sendTransaction', [])).status, 400); assert.equal(calls.length, 0); cases++;
  const accounts = await dispatch('getMultipleAccounts', [policy.accounts, { encoding: 'base64', commitment: 'finalized' }]);
  assert.equal(accounts.status, 200, JSON.stringify({ body: accounts.status === 200 ? null : await accounts.clone().text(), calls, errors }));
  assert.equal(Buffer.from((await accounts.json()).result.value[5].data[0], 'base64').length, 871827);
  assert.deepEqual(calls.map(call => call.method), ['getGenesisHash', 'getMultipleAccounts']); cases++;
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transactionBase64, 'base64')); tx.sign([owner, collection]);
  assert.equal((await dispatch('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), {
    encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false, minContextSlot: 9 }])).status, 200); cases++;
  const before = calls.length;
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => dispatch()));
  assert.equal(concurrent.filter(response => response.status === 200).length, 1);
  assert.equal(concurrent.filter(response => response.status === 429).length, 11);
  assert.equal(calls.length, before + 1); cases++;
  mode = '429'; const failure = await dispatch();
  assert.equal(failure.status, 429); assert.equal(failure.headers.get('retry-after'), '5');
  assert.ok(!(await failure.text()).includes(secret)); const charged = calls.length;
  await mf.dispose(); await start();
  assert.equal((await dispatch()).status, 429); assert.equal(calls.length, charged); cases++;
  await new Promise(resolve => setTimeout(resolve, 5100)); mode = 'normal';
  assert.equal((await dispatch()).status, 200);
  await mf.dispose(); await start(); assert.equal((await dispatch()).status, 200);
  const limited = await dispatch(); assert.equal(limited.status, 429); assert.equal((await limited.json()).error.data.category, 'DAILY_LIMIT');
  assert.equal(calls.length, 7); assert.equal((await mf.listDurableObjectIds('DeploymentGate', name)).length, 1); cases++;
  sendPhase = true; await mf.dispose(); await start();
  const options = { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0, minContextSlot: 9 };
  const bytes = Buffer.from(tx.serialize()).toString('base64'), signature = inspectSignedDeploymentTransaction(bytes).signature;
  const sent = await dispatch('sendTransaction', [bytes, options]);
  assert.equal(sent.status, 200, await sent.clone().text()); assert.equal((await sent.json()).result, signature); cases++;
  const sentCount = calls.length;
  await mf.dispose(); await start();
  assert.equal((await dispatch('sendTransaction', [bytes, options])).status, 409);
  tx.message.recentBlockhash = key('new-hash').publicKey.toBase58(); tx.sign([owner, collection]);
  assert.equal((await dispatch('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), options])).status, 409);
  assert.equal(calls.length, sentCount); cases++;
  assert.equal((await dispatch('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).status, 200);
  assert.equal((await dispatch('getTransaction', [signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])).status, 200); cases++;
  mode = 'failed'; failedBytes = bytes;
  const review = await dispatch('coolbears_authorizeFailedRetry', [bytes]);
  assert.equal(review.status, 200, await review.clone().text());
  const authorization = (await review.json()).result; assert.equal(authorization.status, 'retry-authorized');
  const reviewedCount = calls.length; await mf.dispose(); await start();
  const recovered = await dispatch('coolbears_authorizeFailedRetry', [bytes]);
  assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json()).result, authorization);
  assert.equal(calls.length, reviewedCount); cases++;
  assert.equal((await dispatch('sendTransaction', [bytes, options])).status, 409);
  const retryBytes = Buffer.from(tx.serialize()).toString('base64');
  assert.equal((await dispatch('sendTransaction', [retryBytes, options])).status, 200);
  await mf.dispose(); await start();
  assert.equal((await dispatch('sendTransaction', [retryBytes, options])).status, 409);
  assert.equal((await dispatch('coolbears_authorizeFailedRetry', [bytes])).status, 409);
  assert.equal((await dispatch('getTransaction', [signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])).status, 200); cases++;
  const second = VersionedTransaction.deserialize(Buffer.from(plan.steps[1].transactionBase64, 'base64')); second.sign([owner, key('asset')]);
  const secondBytes = Buffer.from(second.serialize()).toString('base64'); mode = 'send-lost';
  assert.equal((await dispatch('sendTransaction', [secondBytes, options])).status, 503);
  const afterLoss = calls.length; await mf.dispose(); await start(); mode = 'normal';
  assert.equal((await dispatch('sendTransaction', [secondBytes, options])).status, 409);
  assert.equal(calls.length, afterLoss); assert.equal(calls.filter(call => call.method === 'sendTransaction').length, 3); cases++;
  // Same real SQLite survives expiry authorization and a replacement attempt.
  // The cooldown above belongs only to this disposable intercepted fixture.
  await new Promise(resolve => setTimeout(resolve, 5100)); mode = 'expiry';
  expiryHash = key('expiry-hash').publicKey.toBase58(); fundingSignature = signature;
  const third = VersionedTransaction.deserialize(Buffer.from(plan.steps[2].transactionBase64, 'base64'));
  third.message.recentBlockhash = expiryHash; third.sign([owner, key('machine')]);
  const thirdBytes = Buffer.from(third.serialize()).toString('base64');
  assert.equal((await dispatch('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: 0 }])).status, 200);
  assert.equal((await dispatch('sendTransaction', [thirdBytes, options])).status, 200);
  await mf.dispose(); await start();
  const expired = await dispatch('coolbears_authorizeExpiredRetry', [thirdBytes]);
  assert.equal(expired.status, 200, await expired.clone().text());
  const expiryAuthorization = (await expired.json()).result;
  assert.equal(expiryAuthorization.kind, 'expired'); assert.equal(expiryAuthorization.historyPages, 1); cases++;
  const afterExpiry = calls.length; await mf.dispose(); await start();
  const expiryRecovered = await dispatch('coolbears_authorizeExpiredRetry', [thirdBytes]);
  assert.equal(expiryRecovered.status, 200); assert.deepEqual((await expiryRecovered.json()).result, expiryAuthorization);
  assert.equal((await dispatch('sendTransaction', [thirdBytes, options])).status, 409);
  assert.equal(calls.length, afterExpiry); cases++;
  third.message.recentBlockhash = key('expiry-replacement').publicKey.toBase58(); third.sign([owner, key('machine')]);
  const thirdRetry = Buffer.from(third.serialize()).toString('base64');
  assert.equal((await dispatch('sendTransaction', [thirdRetry, options])).status, 200);
  await mf.dispose(); await start();
  assert.equal((await dispatch('sendTransaction', [thirdRetry, options])).status, 409);
  assert.equal((await dispatch('coolbears_authorizeExpiredRetry', [thirdBytes])).status, 409);
  assert.equal(calls.filter(call => call.method === 'sendTransaction').length, 5); cases++;
  assert.ok(calls.slice(1).every((call, i) => call.at - calls[i].at >= 195));
  assert.deepEqual(errors, []);
  const version = JSON.parse(await readFile(path.join(root, 'node_modules/miniflare/package.json'), 'utf8')).version;
  console.log(JSON.stringify({ passed: true, engine: 'workerd', miniflare: version, storage: 'SQLite', cases,
    upstreamRequests: calls.length, bundleBytes: Buffer.byteLength(contents), bundleSha256: createHash('sha256').update(contents).digest('hex'),
    fixtureSubmissions: 5, outboundNetwork: 'intercepted fixtures only', cloudflareDeployed: false, liveDevnet: false, transactionsSent: 0 }));
} finally { if (mf) await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
