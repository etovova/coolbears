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
const { worker, DeploymentGate } = makeGateway(${JSON.stringify(policy)});
export { DeploymentGate }; export default worker;`, resolveDir: root, sourcefile: 'gateway-fixture.mjs' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['node:*'] });
const contents = bundled.outputFiles[0].text;
// Full SDK/CLI builders must not enter the private Worker bundle.
assert.ok(!contents.includes('buildDeploymentCostModel')); assert.ok(!contents.includes('validateCanonicalDeploymentManifest'));
const persist = await mkdtemp(path.join(tmpdir(), 'coolbears-operator-runtime-'));
const name = 'coolbears-deployment-rpc-runtime', endpoint = 'https://private-operator.test/rpc';
const token = 'W'.repeat(43), secret = 'runtime-private-sentinel', calls = [], errors = [];
let mf, mode = 'normal';
async function outbound(request) {
  const url = new URL(request.url); assert.equal(url.hostname, 'devnet.helius-rpc.com');
  assert.equal(url.searchParams.get('api-key'), secret); assert.equal(request.headers.has('authorization'), false);
  const rpc = await request.json(); calls.push({ method: rpc.method, at: Date.now() });
  assert.ok(['getGenesisHash', 'getMultipleAccounts', 'getFeeForMessage', 'simulateTransaction'].includes(rpc.method));
  if (mode === '429') return new RuntimeResponse(secret, { status: 429, headers: { 'retry-after': '5' } });
  let result;
  if (rpc.method === 'getGenesisHash') result = GENESIS_HASHES.devnet;
  if (rpc.method === 'getMultipleAccounts') result = { context: { slot: 9 }, value: [null, null, null, null, null,
    { data: [Buffer.alloc(plan.machineSpace).toString('base64'), 'base64'] }, null] };
  if (rpc.method === 'getFeeForMessage') result = { context: { slot: 9 }, value: 10000 };
  if (rpc.method === 'simulateTransaction') result = { context: { slot: 9 }, value: { err: null, logs: [], unitsConsumed: 1 } };
  return new RuntimeResponse(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
}
async function start() {
  mf = new Miniflare({ telemetry: { enabled: false }, cf: false, logRequests: false, resourcePersistencePath: persist,
    handleUncaughtError: error => errors.push(error.message), workers: [{ config: {
      name, compatibilityDate: '2026-09-23', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents } } },
      env: { OPERATOR_RPC_TOKEN: { type: 'text', value: token }, HELIUS_API_KEY: { type: 'text', value: secret },
        DAILY_CREDIT_CAP: { type: 'text', value: '7' }, DAILY_SIMULATION_CAP: { type: 'text', value: '1' },
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
  assert.ok(calls.slice(1).every((call, i) => call.at - calls[i].at >= 195));
  assert.deepEqual(errors, []);
  const version = JSON.parse(await readFile(path.join(root, 'node_modules/miniflare/package.json'), 'utf8')).version;
  console.log(JSON.stringify({ passed: true, engine: 'workerd', miniflare: version, storage: 'SQLite', cases,
    upstreamRequests: calls.length, bundleBytes: Buffer.byteLength(contents), bundleSha256: createHash('sha256').update(contents).digest('hex'),
    outboundNetwork: 'intercepted fixtures only', cloudflareDeployed: false, liveDevnet: false, transactionsSent: 0 }));
} finally { if (mf) await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
