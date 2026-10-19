// OFFLINE Mainnet capability coverage: disposable vaults and synthetic RPC only.
// No production mapping, endpoint, credentials or on-chain transaction is used.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { Key, PluginType, MPL_CORE_PROGRAM_ID, getPluginHeaderV1AccountDataSerializer, getPluginSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { appendDeploymentEvent, readDeploymentJournal } from '../deployment/journal.mjs';
import { verifySigningResponse } from '../deployment/signing.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';

const key = name => Keypair.fromSeed(createHash('sha256').update(`mainnet-sender-TEST:${name}`).digest());
const owner = key('owner'), passphrase = Buffer.from('mainnet-sender-TEST-only-passphrase');
const commitment = createHash('sha256').update('mainnet-sender-TEST-only-mapping').digest('hex');
const endpoint = 'https://mainnet-sender.test/rpc', stepId = 'collection-create';
const originalOwner = policy.owner, originalFetch = globalThis.fetch;
let mainnet, devnet, sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep, reviewExpiredDeploymentStep, runDeploymentSenderCli;

async function fixture(cluster) {
  const bundle = await createDeploymentSignerVault({ id: `sender-${cluster}-TEST`, cluster,
    blockhash: key(`${cluster}-hash`).publicKey.toBase58(), lastValidBlockHeight: 2000,
    machineRentLamports: '5000000000', storageMode: 'hidden-settings', hiddenCommitmentSha256: commitment, passphrase });
  const vault = await openDeploymentSignerVault({ ...bundle, passphrase });
  let request;
  try { request = await vault.partialSign({ stepId, transactionBase64: bundle.manifest.steps[0].transactionBase64,
    lastValidBlockHeight: 2000, attempt: 1 }); }
  finally { vault.dispose(); }
  const transaction = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, 'base64'));
  transaction.sign([owner]);
  const signed = verifySigningResponse(request, { transactionBase64: Buffer.from(transaction.serialize()).toString('base64') });
  return { ...bundle, request, signed };
}
before(async () => {
  policy.owner = owner.publicKey.toBase58(); globalThis.fetch = () => assert.fail('Live HTTP forbidden');
  ({ sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep, reviewExpiredDeploymentStep } = await import('../deployment/sender.mjs'));
  ({ runDeploymentSenderCli } = await import('../deployment/send-cli.mjs'));
  mainnet = await fixture('mainnet-beta'); devnet = await fixture('devnet');
});
after(() => { policy.owner = originalOwner; globalThis.fetch = originalFetch; });

async function harness(t, selected = mainnet) {
  const parent = await mkdtemp(path.join(tmpdir(), 'coolbears-mainnet-sender-TEST-')), directory = path.join(parent, 'bundle');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { journalDirectory } = await createDeploymentBundle({ directory, manifest: selected.manifest, vault: selected.vault });
  await appendDeploymentEvent(journalDirectory, { type: 'prepare', stepId, request: selected.request, retry: false }, { expectedRevision: 0 });
  await appendDeploymentEvent(journalDirectory, { type: 'signed', stepId, attempt: 1, transactionBase64: selected.signed.transactionBase64 }, { expectedRevision: 1 });
  return { directory, journalDirectory, selected, snapshot: () => readDeploymentJournal(journalDirectory) };
}
function collectionAccount(selected) {
  const expected = selected.manifest.steps[0].expected;
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1, updateAuthority: policy.owner,
    name: expected.name, uri: expected.uri, numMinted: 0, currentSize: 0 });
  const royalty = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{ basisPoints: 700,
    creators: [{ address: policy.owner, percentage: 100 }], ruleSet: { __kind: 'None' } }] });
  const offset = base.length + 9;
  const header = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: offset + royalty.length });
  const registry = getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1,
    registry: [{ pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset }], externalRegistry: [] });
  const data = Buffer.concat([base, header, royalty, registry]);
  return { data: [data.toString('base64'), 'base64'], executable: false, lamports: 2000000, owner: MPL_CORE_PROGRAM_ID, rentEpoch: 0, space: data.length };
}
function upstream(selected = mainnet, { completed = false, override = {}, onCall } = {}) {
  const calls = [];
  const results = { getGenesisHash: GENESIS_HASHES[selected.manifest.cluster],
    getMultipleAccounts: { context: { slot: 510 }, value: [{ executable: true }, { executable: true }, { executable: true }, completed ? collectionAccount(selected) : null, null, null, null] },
    getBalance: { context: { slot: 511 }, value: 10000000000 }, getMinimumBalanceForRentExemption: 5000000000,
    getFeeForMessage: { context: { slot: 513 }, value: 10000 }, isBlockhashValid: { context: { slot: 514 }, value: true }, getBlockHeight: 1500,
    simulateTransaction: { context: { slot: 514 }, value: { err: null, unitsConsumed: 5000 } }, sendTransaction: selected.signed.signature,
    getSignatureStatuses: { context: { slot: 509 }, value: [{ slot: 500, confirmations: null, err: null, confirmationStatus: 'finalized' }] },
    getTransaction: { slot: 500, version: 0, meta: { err: null }, transaction: [selected.signed.transactionBase64, 'base64'] }, ...override };
  return { calls, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    const response = await onCall?.(call, results); if (response) return response;
    assert.ok(Object.hasOwn(results, call.method), call.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: results[call.method] }));
  } };
}
const send = (h, rpc, extra = {}) => sendDeploymentStep({ directory: h.directory, stepId, endpoint, fetchImpl: rpc.fetchImpl,
  authorizeMainnetSend: true, trustedHiddenCommitmentSha256: commitment, ...extra });
const resume = (h, rpc, extra = {}) => resumeDeploymentStep({ directory: h.directory, stepId, endpoint,
  fetchImpl: rpc.fetchImpl, authorizeMainnet: true, trustedHiddenCommitmentSha256: commitment, ...extra });
const review = (h, rpc, extra = {}) => reviewFailedDeploymentStep({ directory: h.directory, stepId, endpoint,
  fetchImpl: rpc.fetchImpl, authorizeRetryReview: true, authorizeMainnet: true, trustedHiddenCommitmentSha256: commitment, ...extra });
const expire = (h, rpc, extra = {}) => reviewExpiredDeploymentStep({ directory: h.directory, stepId, endpoint,
  fetchImpl: rpc.fetchImpl, authorizeRetryReview: true, authorizeMainnet: true, trustedHiddenCommitmentSha256: commitment, ...extra });

test('Mainnet explicit send preserves exact bytes, durable claim and read-only finalized recovery', async t => {
  const h = await harness(t), rpc = upstream(mainnet, { onCall: async call => {
    if (call.method === 'sendTransaction') {
      assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'send-claimed');
      assert.equal(call.params[0], mainnet.signed.transactionBase64);
    }
  } });
  const result = await send(h, rpc); assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.submissionAttempts, 1); assert.equal(result.salesOpen, false); assert.equal(result.readyToOpenSales, false);
  assert.equal(rpc.calls.filter(c => c.method === 'sendTransaction').length, 1);
  assert.equal(rpc.calls.some(c => c.method === 'getLatestBlockhash'), false);
  const recovery = upstream(mainnet, { completed: true });
  const recovered = await resume(h, recovery); assert.equal(recovered.status, 'verified', JSON.stringify(recovered));
  assert.equal(recovery.calls.some(c => c.method === 'sendTransaction'), false);
  assert.equal(recovered.transactionsSent, 0); assert.equal(recovered.journalWrites, 1);
  const snapshot = await h.snapshot(); assert.equal(snapshot.revision, 5);
  assert.equal(snapshot.steps[0].attempts[0].request.cluster, 'mainnet-beta');
  assert.equal(snapshot.steps[0].attempts[0].signed.transactionBase64, mainnet.signed.transactionBase64);
  const denied = upstream();
  assert.equal((await resume(h, denied, { authorizeMainnet: false })).code, 'NETWORK_READ_AUTHORIZATION_REQUIRED');
  assert.equal(denied.calls.length, 0); assert.equal((await h.snapshot()).revision, 5);
});

test('crossed, missing, simultaneous and nonboolean network authorizations never inspect RPC or claim', async t => {
  const main = await harness(t), dev = await harness(t, devnet);
  for (const [h, options] of [[main, { authorizeMainnetSend: false }],
    [main, { authorizeMainnetSend: false, authorizeDevnetSend: true }],
    [main, { authorizeDevnetSend: true }], [main, { authorizeMainnetSend: 'true' }],
    [dev, {}], [dev, { authorizeDevnetSend: true }]]) {
    const rpc = upstream(h.selected), result = await send(h, rpc, options);
    assert.equal(result.status, 'blocked'); assert.equal(result.submissionAttempts, 0);
    assert.equal(rpc.calls.length, 0); assert.equal((await h.snapshot()).revision, 2);
  }
  const rpc = upstream(devnet), result = await send(dev, rpc, { authorizeMainnetSend: false, authorizeDevnetSend: true });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(rpc.calls.filter(c => c.method === 'sendTransaction').length, 1);
  for (const [h, authorization] of [[main, false], [main, 'true'], [dev, true]]) {
    const read = upstream(h.selected);
    assert.equal((await resume(h, read, { authorizeMainnet: authorization })).code, 'NETWORK_READ_AUTHORIZATION_REQUIRED');
    assert.equal(read.calls.length, 0);
  }
});

test('the journal network and separately expected hidden digest reject mismatched genesis/digest before claim', async t => {
  const h = await harness(t);
  const wrongNetwork = upstream(mainnet, { override: { getGenesisHash: GENESIS_HASHES.devnet } });
  const wrong = await send(h, wrongNetwork); assert.equal(wrong.status, 'blocked');
  assert.equal(wrongNetwork.calls.some(c => c.method === 'sendTransaction'), false);
  assert.equal((await h.snapshot()).revision, 2);
  let genesisReads = 0;
  const pivoted = upstream(mainnet, { onCall: call => {
    if (call.method === 'getGenesisHash' && ++genesisReads === 3)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: GENESIS_HASHES.devnet }));
  } });
  const pivot = await send(h, pivoted); assert.equal(pivot.status, 'blocked');
  assert.equal(genesisReads, 3); assert.equal(pivoted.calls.some(c => c.method === 'sendTransaction'), false);
  assert.equal((await h.snapshot()).revision, 2);
  for (const value of [undefined, '', 'b'.repeat(64), '0'.repeat(64), commitment.toUpperCase()]) {
    const wrongDigest = upstream();
    const digest = await send(h, wrongDigest, { trustedHiddenCommitmentSha256: value });
    assert.equal(digest.code, 'TRUSTED_HIDDEN_COMMITMENT_REQUIRED'); assert.equal(wrongDigest.calls.length, 0);
    assert.equal((await h.snapshot()).revision, 2);
    const recovery = upstream();
    assert.equal((await resume(h, recovery, { trustedHiddenCommitmentSha256: value })).code, 'TRUSTED_HIDDEN_COMMITMENT_REQUIRED');
    assert.equal(recovery.calls.length, 0);
  }
});

test('Mainnet failed retry review is separate from send and rejects missing opt-in and cross-network authorization', async t => {
  const h = await harness(t), none = upstream();
  const blocked = await review(h, none, { authorizeMainnet: false });
  assert.equal(blocked.code, 'NETWORK_RETRY_REVIEW_AUTHORIZATION_REQUIRED'); assert.equal(none.calls.length, 0);
  const error = { InstructionError: [0, 'InvalidArgument'] };
  const authorization = { status: 'retry-authorized', cluster: 'mainnet-beta', signature: mainnet.signed.signature,
    slot: 500, transactionSha256: createHash('sha256').update(Buffer.from(mainnet.signed.transactionBase64, 'base64')).digest('hex') };
  const failed = cluster => upstream(mainnet, { override: {
    getSignatureStatuses: { context: { slot: 509 }, value: [{ slot: 500, confirmations: null, err: error, confirmationStatus: 'finalized' }] },
    getTransaction: { slot: 500, version: 0, meta: { err: error }, transaction: [mainnet.signed.transactionBase64, 'base64'] },
    coolbears_authorizeFailedRetry: { ...authorization, cluster } } });
  const crossed = failed('devnet'), rejected = await review(h, crossed);
  assert.equal(rejected.code, 'GATEWAY_RETRY_NOT_AUTHORIZED'); assert.equal((await h.snapshot()).revision, 2);
  const correct = failed('mainnet-beta'), result = await review(h, correct);
  assert.equal(result.status, 'failed', JSON.stringify(result)); assert.equal(result.transactionsSent, 0);
  assert.equal(correct.calls.some(c => c.method === 'sendTransaction'), false);
  assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'failed');
});

test('Mainnet expiry review uses separate read opt-in, exact network evidence and no submission', async t => {
  const h = await harness(t), none = upstream();
  assert.equal((await expire(h, none, { authorizeMainnet: false })).code, 'NETWORK_RETRY_REVIEW_AUTHORIZATION_REQUIRED');
  assert.equal(none.calls.length, 0);
  const evidence = { blockhash: mainnet.request.blockhash, anchorSlot: 1000, slot: 2500, blockHeight: 2100,
    lastValidBlockHeight: 2000, historyPages: 1, historySha256: 'a'.repeat(64) };
  const expired = cluster => upstream(mainnet, { override: {
    coolbears_authorizeExpiredRetry: { ...evidence, status: 'retry-authorized', kind: 'expired', cluster,
      signature: mainnet.signed.signature,
      transactionSha256: createHash('sha256').update(Buffer.from(mainnet.signed.transactionBase64, 'base64')).digest('hex') },
    isBlockhashValid: { context: { slot: 2600 }, value: false }, getBlockHeight: 2100,
    getSignatureStatuses: { context: { slot: 2700 }, value: [null] }, getTransaction: null,
    getMultipleAccounts: { context: { slot: 2701 }, value: [{ executable: true }, { executable: true }, { executable: true }, null, null, null, null] } } });
  const crossed = expired('devnet');
  assert.equal((await expire(h, crossed)).code, 'GATEWAY_RETRY_NOT_AUTHORIZED'); assert.equal((await h.snapshot()).revision, 2);
  const rpc = expired('mainnet-beta'), result = await expire(h, rpc);
  assert.equal(result.status, 'expired', JSON.stringify(result)); assert.equal(result.transactionsSent, 0);
  assert.equal(rpc.calls.some(c => c.method === 'sendTransaction'), false);
  assert.equal((await h.snapshot()).steps[0].attempts[0].state, 'expired');
});

test('CLI network flags are exact; environment labels cannot pivot a Mainnet journal into Devnet', async t => {
  const h = await harness(t), token = 'T'.repeat(43), env = { COOLBEARS_RPC_URL: endpoint,
    COOLBEARS_OPERATOR_RPC_TOKEN: token, COOLBEARS_HIDDEN_COMMITMENT_SHA256: commitment,
    COOLBEARS_NETWORK: 'devnet', COOLBEARS_CLUSTER: 'devnet' };
  let output = '', rpc = upstream(); const write = text => { output += text; };
  for (const flags of [[], ['--devnet-send', '--mainnet-send'], ['--mainnet'], ['--mainnet-send', '--mainnet-send']]) {
    assert.equal(await runDeploymentSenderCli(['send-one', h.directory, stepId, ...flags], { env, fetchImpl: rpc.fetchImpl, write }), 1);
    assert.equal(rpc.calls.length, 0); assert.equal((await h.snapshot()).revision, 2);
  }
  output = '';
  assert.equal(await runDeploymentSenderCli(['send-one', h.directory, stepId, '--devnet-send'], { env, fetchImpl: rpc.fetchImpl, write }), 1);
  assert.equal(rpc.calls.length, 0); assert.equal((await h.snapshot()).revision, 2);
  output = '';
  assert.equal(await runDeploymentSenderCli(['send-one', h.directory, stepId, '--mainnet-send'], { env, fetchImpl: rpc.fetchImpl, write }), 0, output);
  assert.equal(rpc.calls.filter(c => c.method === 'sendTransaction').length, 1);
  assert.equal(output.includes(token), false); assert.equal(output.includes(mainnet.signed.transactionBase64), false);
  rpc = upstream(mainnet, { completed: true }); output = '';
  assert.equal(await runDeploymentSenderCli(['resume', h.directory, stepId], { env, fetchImpl: rpc.fetchImpl, write }), 1, output);
  assert.equal(rpc.calls.length, 0); assert.equal((await h.snapshot()).revision, 4);
  output = '';
  assert.equal(await runDeploymentSenderCli(['resume', h.directory, stepId, '--mainnet'], { env, fetchImpl: rpc.fetchImpl, write }), 0, output);
  assert.equal(rpc.calls.some(c => c.method === 'sendTransaction'), false);
});
