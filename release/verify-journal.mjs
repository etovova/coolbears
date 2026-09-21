// Fault-injection tests of durable submission, not network/Phantom acceptance.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { collectionBuilder } from './settings.mjs';
import { transactionJournal } from './transaction-journal.mjs';

function fixture() {
  const umi = createUmi('http://127.0.0.1:8899');
  const payer = generateSigner(umi); umi.use(signerIdentity(payer));
  const collection = generateSigner(umi);
  const builder = collectionBuilder(umi, collection, { owner: payer.publicKey });
  const f = { umi, builder, state: { receipts: {} }, disk: null, sends: 0, verifications: 0,
    time: 0, chainStatus: null, loseResponse: false, unresolved: false, saveFailure: false,
    statusFailure: false, simulationError: null, rejectSignature: false };
  const sign = payer.signTransaction.bind(payer);
  payer.signTransaction = async tx => { if (f.rejectSignature) throw Error('Wallet rejected signature'); return sign(tx); };
  umi.rpc.getLatestBlockhash = async () => ({ blockhash: collection.publicKey, lastValidBlockHeight: 999 });
  umi.rpc.simulateTransaction = async () => ({ err: f.simulationError, logs: [] });
  umi.rpc.sendTransaction = async tx => {
    // The persistent copy must already contain this exact signed transaction.
    const receipt = JSON.parse(f.disk).receipts.create;
    assert.equal(receipt.signature, base58.deserialize(tx.signatures[0])[0]);
    assert.equal(receipt.signedBytes, Buffer.from(umi.transactions.serialize(tx)).toString('base64'));
    assert.equal(receipt.status, 'saved-before-send');
    f.sends++;
    f.chainStatus = f.unresolved ? null : { commitment: 'confirmed', error: null };
    if (f.loseResponse) throw Error('Response lost after submission');
    return tx.signatures[0];
  };
  umi.rpc.getSignatureStatuses = async () => { if (f.statusFailure) throw Error('Status server unavailable'); return [f.chainStatus]; };
  f.save = async () => { if (f.saveFailure) throw Error('Disk unavailable'); f.disk = JSON.stringify(f.state); };
  f.verify = async () => { f.verifications++; assert.equal(f.chainStatus?.error, null); };
  f.restart = () => {
    if (f.disk) f.state = JSON.parse(f.disk);
    f.execute = transactionJournal({ umi, state: f.state, save: f.save,
      now: () => f.time, wait: async ms => { f.time += ms; }, confirmationMs: 20, pollMs: 5 });
  };
  f.restart(); return f;
}
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); }
try {
  await check('signature rejection leaves no receipt and sends nothing', async () => {
    const f = fixture(); f.rejectSignature = true;
    await assert.rejects(f.execute('create', f.builder, f.verify), /rejected/);
    assert.equal(f.sends, 0); assert.deepEqual(f.state.receipts, {});
  });
  await check('failed simulation sends nothing', async () => {
    const f = fixture(); f.simulationError = 'InsufficientFunds';
    await assert.rejects(f.execute('create', f.builder, f.verify), /simulation failed/);
    assert.equal(f.sends, 0); assert.deepEqual(f.state.receipts, {});
  });
  await check('failed persistence prevents submission', async () => {
    const f = fixture(); f.saveFailure = true;
    await assert.rejects(f.execute('create', f.builder, f.verify), /Disk unavailable/);
    assert.equal(f.sends, 0);
  });
  await check('response lost after send resumes with the same signature and no resend', async () => {
    const f = fixture(); f.loseResponse = true;
    await assert.rejects(f.execute('create', f.builder, f.verify), /Response lost/);
    const signature = f.state.receipts.create.signature;
    f.restart(); await f.execute('create', f.builder, f.verify);
    assert.equal(f.sends, 1); assert.equal(f.state.receipts.create.signature, signature);
    assert.equal(f.state.receipts.create.status, 'verified'); assert.equal(f.verifications, 1);
  });
  await check('unresolved signature times out and restart never replaces it', async () => {
    const f = fixture(); f.unresolved = true;
    await assert.rejects(f.execute('create', f.builder, f.verify), /confirmation pending/);
    f.restart(); await assert.rejects(f.execute('create', f.builder, f.verify), /still unresolved/);
    assert.equal(f.sends, 1); assert.equal(f.verifications, 0);
  });
  await check('status service failure preserves the receipt', async () => {
    const f = fixture(); f.statusFailure = true;
    await assert.rejects(f.execute('create', f.builder, f.verify), /Status server unavailable/);
    f.statusFailure = false; f.restart(); await f.execute('create', f.builder, f.verify);
    assert.equal(f.sends, 1); assert.equal(f.state.receipts.create.status, 'verified');
  });
  await check('processed-only status cannot be reported as confirmed', async () => {
    const f = fixture(); f.loseResponse = true;
    await assert.rejects(f.execute('create', f.builder, f.verify));
    f.chainStatus = { commitment: 'processed', error: null }; f.restart();
    await assert.rejects(f.execute('create', f.builder, f.verify), /still unresolved/);
    assert.equal(f.sends, 1); assert.equal(f.verifications, 0);
  });
  await check('confirmed on-chain failure is not accepted or resubmitted', async () => {
    const f = fixture(); f.loseResponse = true;
    await assert.rejects(f.execute('create', f.builder, f.verify));
    f.chainStatus = { commitment: 'confirmed', error: 'InstructionError' }; f.restart();
    await assert.rejects(f.execute('create', f.builder, f.verify), /failed on-chain/);
    assert.equal(f.sends, 1); assert.equal(f.verifications, 0);
  });
  await check('account verification failure is retried without a new transaction', async () => {
    const f = fixture();
    await assert.rejects(f.execute('create', f.builder, async () => { throw Error('Read unavailable'); }), /Read unavailable/);
    f.restart(); await f.execute('create', f.builder, f.verify);
    assert.equal(f.sends, 1); assert.equal(f.state.receipts.create.status, 'verified');
  });
  await check('completed restart validates historical receipt without obsolete state assertions', async () => {
    const f = fixture(); await f.execute('create', f.builder, f.verify);
    f.restart(); await f.execute('create', f.builder, async () => { throw Error('Later step changed state'); });
    assert.equal(f.sends, 1); assert.equal(f.verifications, 1);
  });
  const report = { checkedAt: new Date().toISOString(), passed: true,
    scope: 'fault injection with real SDK signatures and simulated transport; not real Devnet/Phantom', checks };
  await writeFile(new URL('./reports/journal.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(new URL('./reports/journal.json', import.meta.url), JSON.stringify({ passed: false, checks, error: error.message }, null, 2) + '\n');
  throw error;
}
