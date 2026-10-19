import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { LiteSVM, FailedTransactionMetadata, Rent } from 'litesvm';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { ISOLATED_PROGRAMS, RENT_SYSVAR, CLOCK_SYSVAR, UPGRADEABLE_LOADER,
  captureIsolatedSnapshot, decodeIsolatedSnapshot } from '../deployment/isolated-snapshot.mjs';
import { unsignedVmTransaction } from '../deployment/isolated.mjs';
import { previewIsolatedDeployment } from '../deployment/isolated-preview.mjs';

const address = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const sourceAccount = (bytes, owner, executable = false) => ({ owner, executable,
  lamports: 10000000000, space: bytes.length, data: [bytes.toString('base64'), 'base64'] });
function fixture() {
  const dataAddresses = [address(11), address(12), address(13)];
  const programs = dataAddresses.map(a => {
    const b = Buffer.alloc(36); b.writeUInt32LE(2); new PublicKey(a).toBuffer().copy(b, 4);
    return sourceAccount(b, UPGRADEABLE_LOADER, true);
  });
  const data = dataAddresses.map(() => {
    const b = Buffer.alloc(64); b.writeUInt32LE(3); b.writeBigUInt64LE(99n, 4); b[12] = 1;
    new PublicKey(address(15)).toBuffer().copy(b, 13); b.set([127, 69, 76, 70], 45);
    return sourceAccount(b, UPGRADEABLE_LOADER);
  });
  const rent = Buffer.alloc(17); rent.writeBigUInt64LE(5080n); rent.writeDoubleLE(1, 8); rent[16] = 50;
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(100n);
  return { version: 1, genesisHash: GENESIS_HASHES.devnet, capturedAt: '2026-09-23T00:00:00.000Z',
    addresses: [...ISOLATED_PROGRAMS, ...dataAddresses, RENT_SYSVAR, CLOCK_SYSVAR],
    accounts: { context: { slot: 100 }, value: [...programs, ...data,
      sourceAccount(rent, 'Sysvar1111111111111111111111111111111111111'),
      sourceAccount(clock, 'Sysvar1111111111111111111111111111111111111')] } };
}
function mutateAccount(snapshot, index, mutate) {
  const account = snapshot.accounts.value[index], bytes = Buffer.from(account.data[0], 'base64');
  mutate(bytes); account.data[0] = bytes.toString('base64');
}

test('snapshot binds three executable programs, loader data and sysvars to one slot', () => {
  const decoded = decodeIsolatedSnapshot(fixture());
  assert.equal(decoded.slot, 100); assert.equal(decoded.programs.length, 3);
  assert.equal(decoded.programs[0].elfBytes, 19);
  assert.equal(decoded.rent.lamportsPerByteYear, '5080');
  const svm = new LiteSVM();
  svm.setRent(new Rent(BigInt(decoded.rent.lamportsPerByteYear), decoded.rent.exemptionThreshold, decoded.rent.burnPercent));
  assert.equal(svm.minimumBalanceForRentExemption(871827n), 4429531400n);
});

test('wrong cluster, program order, owner and changed program-data pointer fail closed', () => {
  for (const change of [s => { s.genesisHash = GENESIS_HASHES['mainnet-beta']; },
    s => { s.addresses.reverse(); }, s => { s.accounts.value[0].owner = address(20); },
    s => { s.accounts.value[0].executable = false; },
    s => mutateAccount(s, 0, b => b.set(new PublicKey(address(22)).toBytes(), 4))]) {
    const s = fixture(); change(s); assert.throws(() => decodeIsolatedSnapshot(s));
  }
});

test('truncated/invalid ELF, deployment after bank slot, malformed rent and wrong clock are rejected', () => {
  for (const [index, mutate] of [[3, b => b.writeUInt32LE(2)], [3, b => { b[45] = 0; }],
    [3, b => b.writeBigUInt64LE(101n, 4)], [3, b => { b[12] = 2; }],
    [6, b => b.writeDoubleLE(NaN, 8)], [6, b => { b[16] = 255; }], [7, b => b.writeBigUInt64LE(99n)]]) {
    const s = fixture(); mutateAccount(s, index, mutate); assert.throws(() => decodeIsolatedSnapshot(s));
  }
  const s = fixture(); s.accounts.value[3].data[0] += '\n'; assert.throws(() => decodeIsolatedSnapshot(s));
});

test('snapshot capture uses finalized reads and refuses a bank older than discovery', async () => {
  const s = fixture(), calls = [];
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return GENESIS_HASHES.devnet;
    if (calls.length === 2) return { context: { slot: 99 }, value: s.accounts.value.slice(0, 3) };
    return s.accounts;
  } };
  assert.equal((await captureIsolatedSnapshot(rpc)).accounts.context.slot, 100);
  assert.equal(calls.length, 3); assert.equal(calls[2].params[1].minContextSlot, 99);
  assert.equal(calls[2].params[1].commitment, 'finalized');
  calls.length = 0; s.accounts.context.slot = 98;
  await assert.rejects(captureIsolatedSnapshot(rpc), /INVALID_RPC_CONTEXT/);
});

function transfer(svm, lamports = 1000000) {
  const payer = new PublicKey(address(41)), recipient = new PublicKey(address(42));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: svm.latestBlockhash(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports })] }).compileToV0Message());
  return { tx, base64: Buffer.from(tx.serialize()).toString('base64'), payer: payer.toBase58(), recipient: recipient.toBase58() };
}

test('unsigned VM adapter preserves bytes and refuses real signature bytes', () => {
  const { tx, base64 } = transfer(new LiteSVM());
  const adapted = unsignedVmTransaction(base64);
  assert.deepEqual(adapted.vmTransaction.messageBytes, tx.message.serialize());
  tx.signatures[0][0] = 1;
  assert.throws(() => unsignedVmTransaction(Buffer.from(tx.serialize()).toString('base64')), /ISOLATED_REQUIRES_UNSIGNED_TEMPLATE/);
  assert.throws(() => unsignedVmTransaction(base64 + '\n'), /INVALID_ISOLATED_TRANSACTION/);
});

test('local state persists without fetch; duplicate zero signatures work and failures do not transfer funds', () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN'); };
  try {
    const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
    const t = transfer(svm);
    svm.setAccount({ address: t.payer, programAddress: SystemProgram.programId.toBase58(),
      executable: false, lamports: 10000000n, data: new Uint8Array() });
    const tx = unsignedVmTransaction(t.base64).vmTransaction;
    assert.ok(!(svm.sendTransaction(tx) instanceof FailedTransactionMetadata));
    assert.ok(!(svm.sendTransaction(tx) instanceof FailedTransactionMetadata));
    assert.equal(svm.getBalance(t.recipient), 2000000n);
    assert.equal(svm.getBalance(t.payer), 7990000n); // two 5000-lamport runtime fees
    const bad = unsignedVmTransaction(transfer(svm, 20000000).base64).vmTransaction;
    assert.ok(svm.sendTransaction(bad) instanceof FailedTransactionMetadata);
    assert.equal(svm.getBalance(t.recipient), 2000000n);
    svm.expireBlockhash();
    assert.ok(svm.sendTransaction(tx) instanceof FailedTransactionMetadata); // blockhash checks stay enabled
  } finally { globalThis.fetch = savedFetch; }
});

test('public preview stops before execution on wrong genesis and does not expose endpoint credentials', async () => {
  const calls = [];
  const { report, snapshot } = await previewIsolatedDeployment({ endpoint: 'https://rpc.example/?api-key=private-value',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: GENESIS_HASHES['mainnet-beta'] }));
    } });
  assert.deepEqual(calls, ['getGenesisHash']); assert.equal(snapshot, undefined);
  assert.equal(report.status, 'blocked'); assert.equal(report.code, 'RPC_GENESIS');
  assert.equal(report.transactionsSent, 0); assert.equal(report.budgetComplete, false);
  assert.doesNotMatch(JSON.stringify(report), /private-value|api-key/);
});

test('rate limit stops without retries, fallback or a successful budget', async () => {
  let calls = 0;
  const { report } = await previewIsolatedDeployment({ endpoint: 'https://rpc.example/',
    fetchImpl: async () => { calls++; return new Response('provider secret', { status: 429 }); } });
  assert.equal(calls, 1); assert.equal(report.status, 'blocked'); assert.equal(report.code, 'RPC_HTTP');
  assert.equal(report.fundingRecommendationLamports, null); assert.doesNotMatch(JSON.stringify(report), /provider secret/);
});
