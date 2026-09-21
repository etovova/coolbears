// Read-only production-page preflight. No owner key, wallet prompt or submission.
// Use Node's --use-env-proxy flag when the execution environment requires it.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, deserializeCollectionV1 } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { phantomCheck, DEVNET_GENESIS, CORE_PROGRAM } from './phantom-flow.mjs';
import { createRpcFetch } from './phantom-rpc.mjs';
import policy from '../metadata/policy.json' with { type: 'json' };
const endpoint = process.env.COOLBEARS_DEVNET_RPC || 'https://api.devnet.solana.com';
const report = { checkedAt: new Date().toISOString(), endpointOrigin: new URL(endpoint).origin,
  scope: 'real Devnet reads and actual page Core simulation; no wallet approval or transaction submission',
  passed: false, checks: [], submittedTransactions: 0, physicalPhantomVerified: false };
const rpc = createRpcFetch({ fetchImpl: async (url, init) => {
  const method = JSON.parse(init.body).method;
  assert.ok(!['sendTransaction', 'requestAirdrop'].includes(method), 'READ_ONLY_GUARD');
  return fetch(url, { ...init, headers: { ...init.headers, Origin: policy.website } });
} });
const connection = new Connection(endpoint, { fetch: rpc.fetch, disableRetryOnRateLimit: true, commitment: 'confirmed' });
const umi = createUmi(connection).use(mplCore());
async function check(name, fn) { await fn(); report.checks.push(name); console.log('PASS '+name); }
try {
  await check('correct Devnet genesis', async () => assert.equal(await connection.getGenesisHash(), DEVNET_GENESIS));
  const owner = new PublicKey(policy.owner);
  await check('owner finalized balance covers the preflight threshold', async () => {
    report.ownerBalanceLamports = await connection.getBalance(owner, 'finalized'); assert.ok(report.ownerBalanceLamports >= 10000000);
  });
  await check('Core program is executable', async () => {
    const account = await connection.getAccountInfo(new PublicKey(CORE_PROGRAM), 'finalized'); assert.ok(account?.executable);
  });
  await check('existing lab collection deserializes with 7 percent royalties', async () => {
    const key = publicKey('NJb9UojPgLu18UfJiAH9AjgkiMhY9uusE1FRNo7LCmX');
    const raw = await umi.rpc.getAccount(key, { commitment: 'finalized' }); assert.ok(raw.exists);
    assert.equal(raw.owner, CORE_PROGRAM); assert.equal(deserializeCollectionV1(raw).royalties.basisPoints, 700);
  });
  const previous = JSON.parse(await readFile(new URL('./reports/devnet-finalized.json', import.meta.url)));
  const signature = previous.transactions.find(x => x.step === 'paid-mint').signature;
  await check('historical signature lookup returns the finalized successful lab mint', async () => {
    const result = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    assert.equal(result?.confirmationStatus, 'finalized'); assert.equal(result.err, null);
  });
  let intent, transaction;
  const store = { load: async () => intent || null, claim: async candidate => { assert.ok(!intent); intent = candidate; return candidate; } };
  await check('actual page preparation and Core simulation pass without an owner signature', async () => {
    const wallet = { publicKey: owner };
    const flow = phantomCheck({ umi, wallet, store, readHeight: async () => { throw Error('Unexpected confirmation'); },
      send: async tx => { transaction = tx; throw Error('READ_ONLY_STOP_BEFORE_WALLET'); } });
    await assert.rejects(flow.start(), /READ_ONLY_STOP_BEFORE_WALLET/);
    assert.ok(transaction); assert.equal(transaction.feePayer.toBase58(), policy.owner);
    assert.equal(transaction.signatures.find(s => s.publicKey.equals(owner)).signature, null);
    assert.equal(transaction.signatures.filter(s => s.signature !== null).length, 1);
    report.transactionBytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    assert.ok(report.transactionBytes <= 1232); report.uncreatedSimulationAsset = intent.asset;
  });
  await check('finalized height and minimum-context absence check support safe recovery', async () => {
    const info = await connection.getEpochInfo('finalized'); assert.ok(Number.isSafeInteger(info.blockHeight));
    const raw = await connection.getAccountInfo(new PublicKey(intent.asset), { commitment: 'finalized', minContextSlot: info.absoluteSlot });
    assert.equal(raw, null); report.finalizedSlot = info.absoluteSlot;
  });
  await check('simulation did not debit the owner or create an asset', async () => {
    const after = await connection.getBalance(owner, 'finalized'); assert.equal(after, report.ownerBalanceLamports);
  });
  await check('historical transaction details are readable (extra method, not required by the page)', async () => {
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    assert.ok(tx); assert.equal(tx.meta.err, null);
  });
  report.passed = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; }
report.rpc = rpc.diagnostics();
await writeFile(new URL('./reports/phantom-live-rpc.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error }));
