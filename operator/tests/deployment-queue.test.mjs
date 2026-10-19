// Real canonical bundle/journal/crypto, synthetic terminal and intercepted RPC.
// No real owner key, password, endpoint, wallet or blockchain operation.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, readDeploymentJournal } from '../deployment/journal.mjs';
import { readDeploymentQueue, deploymentQueueStatus } from '../deployment/queue.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
const key = name => Keypair.fromSeed(createHash('sha256').update(`queue-fixture-${name}`).digest());
const passphrase = Buffer.from('queue-fixture-passphrase-only'), stepId = 'collection-create';
const endpoint = 'https://queue-fixture.test/rpc', token = 't'.repeat(43);
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
let fixture, request, runOwnerConsole, network;
const fixtures = new Map(), requests = new Map();
before(async () => {
  policy.owner = key('owner').publicKey.toBase58();
  globalThis.fetch = (...args) => network(...args);
  ({ runOwnerConsole } = await import('../deployment/owner-console/cli.mjs'));
  for (const cluster of ['devnet', 'mainnet-beta']) {
    const value = await createDeploymentSignerVault({ id: `queue-${cluster}-fixture`, cluster,
      blockhash: key('old').publicKey.toBase58(), lastValidBlockHeight: 1000,
      machineRentLamports: '5000000000', passphrase });
    fixtures.set(cluster, value);
    const signer = await openDeploymentSignerVault({ ...value, passphrase });
    try { requests.set(cluster, signer.partialSign({ stepId, transactionBase64: value.manifest.steps[0].transactionBase64,
      lastValidBlockHeight: 1000, attempt: 1 })); } finally { signer.dispose(); }
  }
  fixture = fixtures.get('devnet'); request = requests.get('devnet');
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });
async function harness(t, cluster = 'devnet') {
  network = () => assert.fail('Unexpected network access');
  const parent = await mkdtemp(path.join(tmpdir(), 'queue-fixture-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'bundle');
  const { journalDirectory } = await createDeploymentBundle({ directory, ...fixtures.get(cluster) });
  const snapshot = () => readDeploymentJournal(journalDirectory);
  return { directory, journalDirectory, snapshot, async append(type, fields = {}) {
    const before = await snapshot();
    return appendDeploymentEvent(journalDirectory, { type, stepId, attempt: 1, ...fields }, { expectedRevision: before.revision });
  }, async prepare() {
    return appendDeploymentEvent(journalDirectory, { type: 'prepare', stepId, request: requests.get(cluster), retry: false }, { expectedRevision: 0 });
  } };
}
class Input extends EventEmitter {
  isTTY = true; readableLength = 0; readableEncoding = null;
  setRawMode(value) { this.isRaw = value; }
  pause() { this.readableFlowing = false; }
  resume() { this.readableFlowing = true; }
}
function io(onPrompt) {
  const input = new Input(), errorOutput = new EventEmitter();
  errorOutput.isTTY = true;
  let stdout = '', stderr = '', prompts = 0, pending;
  errorOutput.write = text => {
    stderr += text;
    if (text === 'Passphrase (hidden): ') {
      prompts++; assert.ok(onPrompt, 'Unexpected password prompt');
      pending = Promise.resolve().then(onPrompt).then(() => input.emit('data', Buffer.concat([passphrase, Buffer.from('\r')])));
    }
  };
  return { input, errorOutput, output: { write: text => { stdout += text; } }, env: {},
    get stdout() { return stdout; }, get stderr() { return stderr; }, get prompts() { return prompts; },
    async finish() { await pending; } };
}
function rpc(cluster = 'devnet') {
  const calls = [];
  network = async (url, init) => {
    assert.equal(url, endpoint); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    const value = JSON.parse(init.body); calls.push(value.method);
    const result = { getGenesisHash: GENESIS_HASHES[cluster],
      getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] },
      getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
      getLatestBlockhash: { context: { slot: 512 }, value: { blockhash: key('fresh').publicKey.toBase58(), lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 513 }, value: 10000 }, isBlockhashValid: { context: { slot: 514 }, value: true },
      getBlockHeight: 1500, simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } },
    }[value.method];
    assert.notEqual(result, undefined, value.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }));
  };
  return calls;
}

test('offline queue validates bundle without password/RPC, preserves bytes and redacts sensitive fields', async t => {
  const h = await harness(t), before = await h.snapshot(), term = io();
  term.env = { COOLBEARS_RPC_URL: 'INVALID_PRIVATE_SENTINEL', COOLBEARS_OPERATOR_RPC_TOKEN: token };
  assert.equal(await runOwnerConsole(['status', h.directory], term), 0);
  const report = JSON.parse(term.stdout);
  assert.equal(report.next.action, 'prepare'); assert.equal(report.progress.totalSteps, 1431);
  assert.equal(report.progress.verifiedSteps, 0); assert.equal(report.freshChainCheck, false);
  assert.equal(report.networkRequests, 0); assert.equal(report.journalWrites, 0); assert.equal(term.prompts, 0);
  assert.deepEqual(await h.snapshot(), before);
  for (const privateValue of [token, h.directory, 'INVALID_PRIVATE_SENTINEL', passphrase.toString(),
    fixture.vault.ciphertextBase64, fixture.manifest.steps[0].transactionBase64]) {
    if (privateValue) assert.ok(!term.stdout.includes(privateValue));
  }
  const readyPath = path.join(h.directory, 'READY.json'), bytes = await readFile(readyPath);
  await writeFile(readyPath, '{}');
  const broken = io(); assert.equal(await runOwnerConsole(['status', h.directory], broken), 1);
  assert.equal(broken.stdout, ''); assert.equal(broken.prompts, 0);
  await writeFile(readyPath, bytes); // disposable fixture only
});

test('prepare-next uses fresh simulation and one hidden prompt; restart resumes the saved request', async t => {
  const h = await harness(t), calls = rpc(), term = io(() => {});
  term.env = { COOLBEARS_RPC_URL: endpoint, COOLBEARS_OPERATOR_RPC_TOKEN: token };
  assert.equal(await runOwnerConsole(['prepare-next', h.directory], term), 0); await term.finish();
  assert.equal(term.prompts, 1); assert.equal(term.input.isRaw, false);
  assert.equal(JSON.parse(term.stdout).ownerSignatureCreated, false);
  assert.equal(JSON.parse(term.stdout).stepId, stepId); assert.ok(!term.stderr.includes(passphrase.toString()));
  assert.equal(calls.filter(method => method === 'simulateTransaction').length, 1);
  assert.equal(calls.includes('sendTransaction'), false);
  const before = await h.snapshot(), count = calls.length;
  const resumed = await readDeploymentQueue(h.directory); assert.equal(resumed.next.action, 'sign');
  const repeat = io(); repeat.env = term.env;
  assert.equal(await runOwnerConsole(['prepare-next', h.directory], repeat), 1);
  assert.equal(repeat.prompts, 0); assert.equal(calls.length, count); assert.deepEqual(await h.snapshot(), before);
});

test('journal movement while password is entered stops before RPC or a stale retry', async t => {
  const h = await harness(t), term = io(async () => { await h.prepare(); await h.append('cancelled'); });
  term.env = { COOLBEARS_RPC_URL: endpoint, COOLBEARS_OPERATOR_RPC_TOKEN: token };
  assert.equal(await runOwnerConsole(['prepare-next', h.directory], term), 1); await term.finish();
  assert.equal(term.prompts, 1); assert.equal((await h.snapshot()).revision, 2);
  assert.equal((await readDeploymentQueue(h.directory)).next.action, 'manual-retry');
  const repeated = io(); repeated.env = term.env;
  assert.equal(await runOwnerConsole(['prepare-next', h.directory], repeated), 1); assert.equal(repeated.prompts, 0);
});

test('claimed or unknown wallet response never offers signing, sending or automatic retry', async t => {
  const h = await harness(t); await h.prepare();
  await h.append('request-wallet', { claimId: 'c'.repeat(64) });
  const claimed = await readDeploymentQueue(h.directory);
  assert.equal(claimed.next.action, 'recover-wallet-response'); assert.equal(claimed.progress.verifiedSteps, 0);
  assert.ok(claimed.next.commands.every(item => item.args[0] === 'serve'));
  await h.append('unknown'); const unknown = await readDeploymentQueue(h.directory);
  assert.equal(unknown.next.action, 'recover-wallet-response'); assert.equal(unknown.automaticRetry, false);
  const before = await h.snapshot(), term = io();
  assert.equal(await runOwnerConsole(['prepare-next', h.directory], term), 1); assert.equal(term.prompts, 0);
  assert.deepEqual(await h.snapshot(), before);
  // Display-only terminal projection: completion never grants sales permission.
  const display = structuredClone(before);
  display.steps = display.steps.map(step => ({ ...step, attempts: [{ number: 1, state: 'verified' }] }));
  const complete = deploymentQueueStatus(display);
  assert.equal(complete.progress.verifiedSteps, 1431); assert.equal(complete.next.action, 'complete');
  assert.equal(complete.readyToOpenSales, false); assert.equal(complete.freshChainCheck, false);
  assert.deepEqual(complete.next.commands, []);
  display.manifest.cluster = 'mainnet-beta'; assert.equal(deploymentQueueStatus(display).cluster, 'mainnet-beta');
  display.manifest.cluster = 'testnet'; assert.throws(() => deploymentQueueStatus(display), error => error.code === 'DEPLOYMENT_NETWORK_INVALID');
});

test('Mainnet queue recommends separate sign/send grants and CLI prepares only after explicit sign authorization', async t => {
  const h = await harness(t, 'mainnet-beta'), initial = await readDeploymentQueue(h.directory);
  assert.equal(initial.cluster, 'mainnet-beta');
  assert.deepEqual(initial.next.commands[0].args, ['prepare', '<bundle>', stepId, '--mainnet-sign']);
  for (const flags of [[], ['--devnet-send'], ['--mainnet-sign', '--mainnet-sign']]) {
    const denied = io();
    assert.equal(await runOwnerConsole(['prepare-next', h.directory, ...flags], denied), 1);
    assert.equal(denied.prompts, 0); assert.equal((await h.snapshot()).revision, 0);
  }
  const calls = rpc('mainnet-beta'), term = io(() => {});
  term.env = { COOLBEARS_RPC_URL: endpoint, COOLBEARS_OPERATOR_RPC_TOKEN: token };
  assert.equal(await runOwnerConsole(['prepare-next', h.directory, '--mainnet-sign'], term), 0); await term.finish();
  assert.equal(term.prompts, 1); assert.equal(JSON.parse(term.stdout).cluster, 'mainnet-beta');
  assert.ok(!calls.includes('sendTransaction'));
  const pending = await readDeploymentQueue(h.directory);
  assert.deepEqual(pending.next.commands[0].args, ['serve', '<bundle>', '--mainnet-sign']);
  const attempt = (await h.snapshot()).steps[0].attempts[0];
  const tx = VersionedTransaction.deserialize(Buffer.from(attempt.request.transactionBase64, 'base64')); tx.sign([key('owner')]);
  await h.append('signed', { transactionBase64: Buffer.from(tx.serialize()).toString('base64') });
  const signed = await readDeploymentQueue(h.directory);
  assert.deepEqual(signed.next.commands[0].args, ['send-one', '<bundle>', stepId, '--mainnet-send']);
  assert.equal(signed.readyToSubmit, false); assert.equal(signed.salesOpen, false);
  await h.append('claim-send');
  assert.deepEqual((await readDeploymentQueue(h.directory)).next.commands[0].args, ['resume', '<bundle>', stepId, '--mainnet']);
});
