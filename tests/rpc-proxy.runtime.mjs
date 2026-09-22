// Actual workerd + SQLite Durable Object integration, with every outbound HTTP
// request intercepted. This is not a deployed Cloudflare or live Solana test.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
import { VersionedTransaction } from '@solana/web3.js';
import { createClient, readState, prepareMint } from '../devnet/core.mjs';
import { settings as S } from '../devnet/settings.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const bundlePath = path.join(root, 'build/rpc-proxy/worker.js');
const outputPath = path.join(root, 'build/rpc-proxy-runtime.json');
const contents = await readFile(bundlePath, 'utf8');
const fixture = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
const packageInfo = JSON.parse(await readFile(path.join(root, 'node_modules/miniflare/package.json'), 'utf8'));
const persist = await mkdtemp(path.join(tmpdir(), 'coolbears-rpc-runtime-'));
const origin = 'https://coolbears-nfts.com';
const endpoint = 'https://rpc.coolbears.test/rpc';
const secret = 'runtime-fixture-only';
const name = 'coolbears-devnet-rpc';
const report = {
  checkedAt: new Date().toISOString(), passed: false, engine: 'workerd', miniflareVersion: packageInfo.version,
  storage: 'actual SQLite Durable Object', bundleSha256: createHash('sha256').update(contents).digest('hex'),
  outboundNetwork: 'fully intercepted with public RPC fixtures', realWallets: false, ownerSignatures: 0,
  realTransactionsSent: 0, productionDeploymentTested: false, cases: [],
};
const calls = [];
const runtimeErrors = [];
let mode = 'normal', mf;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const body = (method = 'getGenesisHash', params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params });

async function outbound(request) {
  const url = new URL(request.url);
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'devnet.helius-rpc.com');
  assert.equal(url.searchParams.get('api-key'), secret);
  assert.equal(request.method, 'POST');
  const rpc = await request.json();
  assert.notEqual(rpc.method, 'sendTransaction', 'Runtime integration never submits an owner-signed transaction');
  calls.push({ method: rpc.method, receivedAt: Date.now() });
  if (mode === 'provider-error') return new RuntimeResponse(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32005, message: secret, data: { endpoint: request.url, logs: [secret] } } }));
  let result = fixture[rpc.method];
  if (rpc.method === 'getBlockHeight') result = fixture.getLatestBlockhash.value.lastValidBlockHeight - 200;
  if (rpc.method === 'simulateTransaction') result = { context: { slot: 502145500 }, value: { err: null, logs: [], unitsConsumed: 57949 } };
  assert.notEqual(result, undefined, `Unexpected runtime RPC method: ${rpc.method}`);
  return new RuntimeResponse(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'content-type': 'application/json' } });
}

async function start() {
  mf = new Miniflare({
    telemetry: { enabled: false }, cf: false, logRequests: false,
    resourcePersistencePath: persist,
    handleUncaughtError: error => runtimeErrors.push(error.message),
    workers: [{
      config: {
        name, compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
        manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents } } },
        env: {
          HELIUS_API_KEY: { type: 'text', value: secret },
          DAILY_CREDIT_CAP: { type: 'text', value: '20' },
          RPC_GATE: { type: 'durable-object', worker: name, exportName: 'RpcGate' },
        },
        exports: { RpcGate: { type: 'durable-object', storage: 'sqlite' } },
      },
      dev: { outboundService: { type: 'fetcher', handler: outbound } },
    }],
  });
  await mf.ready;
}
function dispatch(rpc = body(), options = {}) {
  const { headers = {}, ...rest } = options;
  return mf.dispatchFetch(endpoint, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(rpc), ...rest });
}
async function scenario(label, callback) {
  const start = Date.now();
  const detail = await callback();
  report.cases.push({ name: label, passed: true, durationMs: Date.now() - start, ...detail });
  console.log('PASS ' + label);
}

try {
  await start();
  await scenario('real Worker dispatch enforces CORS and rejects unauthorized input before upstream', async () => {
    const preflight = await mf.dispatchFetch(endpoint, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const denied = await mf.dispatchFetch(endpoint, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal((await dispatch(body('requestAirdrop', [S.owner, 1000000000]))).status, 400);
    assert.equal(calls.length, 0);
  });

  await scenario('unchanged SDK client reads real account snapshots and simulates an unsigned owner mint in workerd', async () => {
    const client = createClient(async (_url, options) => {
      await delay(150);
      const response = await dispatch(JSON.parse(options.body));
      if (response.status >= 500) {
        report.proxyFailure = { status: response.status, body: await response.text(), mockCalls: calls.length };
        throw Error('Actual runtime request failed; sanitized detail recorded in report');
      }
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }, { endpoint, minIntervalMs: 0 });
    const state = await readState(client);
    assert.equal(state.machine.itemsRedeemed, 1n);
    const prepared = await prepareMint(client, S.owner);
    const transaction = VersionedTransaction.deserialize(prepared.bytes);
    assert.equal(prepared.bytes.length, 622);
    assert.ok(transaction.signatures[0].every(byte => byte === 0));
    assert.ok(transaction.signatures[1].some(byte => byte !== 0));
    assert.equal(prepared.simulation.err, null);
    return { rpcRequests: calls.length, preparedBytes: prepared.bytes.length, ownerSigned: false };
  });

  await scenario('concurrent HTTP requests use one SQLite object and share its rate limit', async () => {
    await delay(160);
    const before = calls.length;
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => dispatch(body('getGenesisHash', [], index + 20))));
    const successes = responses.filter(response => response.status === 200).length;
    const limited = responses.filter(response => response.status === 429).length;
    assert.ok(successes >= 1 && successes < responses.length);
    assert.equal(successes + limited, responses.length);
    assert.equal(calls.length - before, successes);
    for (const response of responses.filter(response => response.status === 429)) assert.ok(Number(response.headers.get('retry-after')) >= 1);
    const ids = await mf.listDurableObjectIds('RpcGate', name);
    assert.equal(ids.length, 1);
    // The production class uses the fetch API, not Durable Object RPC. Verify
    // SQLite persistence from its actual database file without adding a test
    // RPC surface to the production class just for storage introspection.
    const files = await readdir(persist, { recursive: true });
    const sqlite = [];
    for (const file of files.filter(file => /\.(sqlite|db)$/.test(file))) {
      const handle = await open(path.join(persist, file));
      try {
        const header = Buffer.alloc(16);
        await handle.read(header, 0, 16, 0);
        if (header.toString() === 'SQLite format 3\u0000') sqlite.push(file);
      } finally { await handle.close(); }
    }
    assert.ok(sqlite.length >= 1, 'Configured SQLite Durable Object must have a real persisted SQLite database');
    report.persistedSqliteFiles = sqlite.length;
    return { clients: responses.length, admitted: successes, rateLimited: limited, durableObjects: ids.length };
  });

  await scenario('actual service-binding responses redact upstream credentials and errors', async () => {
    await delay(160); mode = 'provider-error';
    const response = await dispatch();
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(JSON.parse(text).error);
    assert.ok(!text.includes(secret)); assert.ok(!text.includes('api-key='));
    assert.ok(!text.includes('logs')); mode = 'normal';
  });

  await scenario('SQLite daily quota persists after full workerd disposal and recreation', async () => {
    let exhausted = false;
    for (let attempt = 0; attempt < 21; attempt++) {
      await delay(160);
      const response = await dispatch();
      if (response.status === 429) {
        assert.equal((await response.json()).error.data.category, 'DAILY_LIMIT');
        exhausted = true; break;
      }
      assert.equal(response.status, 200);
    }
    assert.equal(exhausted, true);
    assert.ok(calls.length <= 20);
    const before = calls.length;
    await mf.dispose(); mf = undefined;
    await start();
    const response = await dispatch();
    assert.equal(response.status, 429);
    const error = await response.json();
    assert.equal(error.error.data.category, 'DAILY_LIMIT');
    assert.equal(calls.length, before);
    assert.equal((await mf.listDurableObjectIds('RpcGate', name)).length, 1);
    return { configuredDailyCap: 20, upstreamRequestsBeforeRestart: before, restarted: true, extraUpstreamRequests: 0 };
  });
  assert.deepEqual(runtimeErrors, []);
  report.upstreamReadAndSimulationRequests = calls.length;
  report.upstreamSubmissionRequests = 0;
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  report.upstreamReadAndSimulationRequests = calls.length;
  throw error;
} finally {
  await mf?.dispose();
  await rm(persist, { recursive: true, force: true });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, scenarios: report.cases.length, engine: report.engine, persistedSqliteFiles: report.persistedSqliteFiles, report: 'build/rpc-proxy-runtime.json' }));
