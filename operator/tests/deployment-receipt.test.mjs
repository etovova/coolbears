// Actual signatures from deterministic offline fixture keys; no live account,
// wallet, transport or deployment evidence is produced by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createSigningRequest, verifySigningResponse } from '../deployment/signing.mjs';
import { verifyFinalizedReceipt, verifyFinalizedFailedTransaction } from '../deployment/receipt.mjs';

const key = label => Keypair.fromSeed(createHash('sha256').update(`deployment-receipt-fixture:${label}`).digest());
const owner = key('owner'), ephemeral = key('ephemeral'), blockhash = key('blockhash').publicKey.toBase58();
const encode = transaction => Buffer.from(transaction.serialize()).toString('base64');
const copy = value => JSON.parse(JSON.stringify(value));
const invalid = input => assert.throws(() => verifyFinalizedReceipt(input), error =>
  error.code === 'DEPLOYMENT_RECEIPT_INVALID' && error.message === 'Finalized transaction receipt could not be verified.');

function fixture(version = 0) {
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.createAccount({ fromPubkey: owner.publicKey,
      newAccountPubkey: ephemeral.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId })] });
  const transaction = new VersionedTransaction(version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
  transaction.sign([ephemeral]);
  const request = createSigningRequest({ deploymentId: 'offline-receipt', stepId: 'collection-create', attempt: 1,
    cluster: 'devnet', owner: owner.publicKey.toBase58(), transactionBase64: encode(transaction), lastValidBlockHeight: 50000 });
  transaction.sign([owner]);
  const signed = verifySigningResponse(request, { transactionBase64: encode(transaction) });
  return {
    request, signed,
    statusResult: { context: { slot: 55002, apiVersion: 'fixture' }, value: [{ slot: 55000,
      confirmations: null, err: null, confirmationStatus: 'finalized', status: { Ok: null } }] },
    transactionResult: { slot: 55000, blockTime: null, meta: { err: null, fee: 10000 },
      transaction: [signed.transactionBase64, 'base64'], version },
  };
}

for (const version of [0, 'legacy']) {
  test(`${version}: accepts finalized success bound to every saved signed byte`, () => {
    const input = fixture(version); const before = JSON.stringify(input);
    const receipt = verifyFinalizedReceipt(copy(input));
    assert.deepEqual(receipt, { slot: 55000, signature: input.signed.signature, messageSha256: input.signed.messageSha256 });
    assert.equal(JSON.stringify(input), before);
    assert.ok(Object.isFrozen(receipt));
    assert.equal('effectsVerified' in receipt, false);
    assert.equal('networkVerified' in receipt, false);
    assert.equal('readyToSubmit' in receipt, false);
  });
}

test('deprecated status detail may be absent but contradictory or malformed results are rejected', () => {
  const input = copy(fixture()); delete input.statusResult.value[0].status;
  assert.equal(verifyFinalizedReceipt(input).slot, 55000);
  for (const status of [null, { Err: 'provider-secret' }, { Ok: 'not-null' }, { Ok: null, Err: null }, {}]) {
    const changed = copy(input); changed.statusResult.value[0].status = status; invalid(changed);
  }
});

test('null, missing or multiple signature statuses cannot establish finalized success', () => {
  const source = fixture();
  for (const statusResult of [null, {}, { context: { slot: 55002 } }, { context: { slot: 55002 }, value: null },
    { context: { slot: 55002 }, value: [] }, { context: { slot: 55002 }, value: [null] },
    { context: { slot: 55002 }, value: [source.statusResult.value[0], source.statusResult.value[0]] }]) {
    invalid({ ...source, statusResult });
  }
  const sparse = copy(source); sparse.statusResult.value = new Array(1); invalid(sparse);
  const wrongEnvelope = copy(source); wrongEnvelope.statusResult = { jsonrpc: '2.0', id: 1, result: source.statusResult }; invalid(wrongEnvelope);
});

test('only explicit finalized, null confirmations and err null are accepted', () => {
  const source = fixture();
  for (const changes of [{ confirmationStatus: 'processed' }, { confirmationStatus: 'confirmed' },
    { confirmationStatus: null }, { confirmations: 0 }, { confirmations: 30 }, { confirmations: 'null' },
    { err: { InstructionError: [0, 'fixture-failure'] } }, { err: false }]) {
    const changed = copy(source); Object.assign(changed.statusResult.value[0], changes); invalid(changed);
  }
  for (const field of ['confirmationStatus', 'confirmations', 'err', 'slot']) {
    const changed = copy(source); delete changed.statusResult.value[0][field]; invalid(changed);
  }
});

test('status and context slots are positive safe integers with status no later than context', () => {
  const source = fixture();
  for (const slot of [0, -1, 1.5, '55000', null, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const changed = copy(source); changed.statusResult.value[0].slot = slot; invalid(changed);
    const contextChanged = copy(source); contextChanged.statusResult.context.slot = slot; invalid(contextChanged);
  }
  const stale = copy(source); stale.statusResult.context.slot = 54999; invalid(stale);
  const missing = copy(source); delete missing.statusResult.context.slot; invalid(missing);
  const noContext = copy(source); delete noContext.statusResult.context; invalid(noContext);
  const equal = copy(source); equal.statusResult.context.slot = 55000;
  assert.equal(verifyFinalizedReceipt(equal).slot, 55000);
});

test('transaction must exist at the same slot with explicit successful metadata', () => {
  const source = fixture();
  for (const transactionResult of [null, {}, { ...source.transactionResult, slot: 54999 },
    { ...source.transactionResult, slot: '55000' }, { ...source.transactionResult, meta: null },
    { ...source.transactionResult, meta: {} }, { ...source.transactionResult, meta: { err: false } },
    { ...source.transactionResult, meta: { err: { InstructionError: [0, 'failure'] } } }]) invalid({ ...source, transactionResult });
  for (const field of ['slot', 'meta', 'version', 'transaction']) {
    const changed = copy(source); delete changed.transactionResult[field]; invalid(changed);
  }
  invalid({ ...source, transactionResult: { result: source.transactionResult } });
});

test('RPC transaction version must match the actual saved version, including legacy', () => {
  for (const version of [0, 'legacy']) {
    const source = fixture(version);
    for (const mismatch of [version === 0 ? 'legacy' : 0, 1, '0', null, false]) {
      const changed = copy(source); changed.transactionResult.version = mismatch; invalid(changed);
    }
  }
});

test('only an exact base64 tuple with canonical signed bytes is accepted', () => {
  const source = fixture(); const text = source.signed.transactionBase64;
  for (const transaction of [null, text, [text], [text, 'base58'], [text, 'json'], [text, 'base64', 'extra'],
    [`${text}\n`, 'base64'], [` ${text}`, 'base64'], ['', 'base64'], ['not-a-transaction', 'base64'],
    [{ signatures: [source.signed.signature] }, 'base64']]) {
    const changed = copy(source); changed.transactionResult.transaction = transaction; invalid(changed);
  }
  const sparse = copy(source); sparse.transactionResult.transaction = new Array(2); invalid(sparse);
});

test('matching claimed transaction ID cannot hide changed message bytes', () => {
  const input = copy(fixture());
  const transaction = VersionedTransaction.deserialize(Buffer.from(input.signed.transactionBase64, 'base64'));
  const originalSignature = transaction.signatures[0].slice();
  transaction.message.compiledInstructions[0].data[4] ^= 1;
  assert.deepEqual(transaction.signatures[0], originalSignature, 'Response still carries the same first signature');
  input.transactionResult.transaction[0] = encode(transaction);
  input.transactionResult.signature = input.signed.signature;
  invalid(input);
});

test('matching owner signature cannot hide a dropped or modified partial signature', () => {
  const source = fixture();
  for (const mutate of [tx => tx.signatures[1].fill(0), tx => { tx.signatures[1][0] ^= 1; }]) {
    const changed = copy(source);
    const transaction = VersionedTransaction.deserialize(Buffer.from(changed.signed.transactionBase64, 'base64'));
    mutate(transaction); changed.transactionResult.transaction[0] = encode(transaction); invalid(changed);
  }
});

test('saved signed response bytes and all derived metadata are reverified', () => {
  const source = fixture();
  for (const changes of [{ signature: ephemeral.publicKey.toBase58() }, { messageSha256: '0'.repeat(64) },
    { blockhash: ephemeral.publicKey.toBase58() }, { requiredSigners: [...source.signed.requiredSigners].reverse() },
    { requiredSigners: new Array(2) }, { transactionBase64: source.request.transactionBase64 }, { unexpected: true }]) {
    invalid({ ...source, signed: { ...source.signed, ...changes } });
  }
  const changed = copy(source);
  const transaction = VersionedTransaction.deserialize(Buffer.from(changed.signed.transactionBase64, 'base64'));
  transaction.signatures[0][63] ^= 1;
  changed.signed.transactionBase64 = encode(transaction);
  changed.transactionResult.transaction[0] = changed.signed.transactionBase64;
  invalid(changed);
  for (const field of Object.keys(source.signed)) {
    const missing = copy(source); delete missing.signed[field]; invalid(missing);
  }
});

test('saved request mutations cannot be legitimized by matching RPC bytes', () => {
  const source = fixture();
  for (const changes of [{ owner: ephemeral.publicKey.toBase58() }, { messageSha256: 'f'.repeat(64) },
    { blockhash: ephemeral.publicKey.toBase58() }, { requiredSigners: [source.request.owner] },
    { transactionBase64: source.signed.transactionBase64 }]) {
    invalid({ ...source, request: { ...source.request, ...changes } });
  }
});

test('malformed inputs and provider exceptions produce only the fixed sanitized error', () => {
  for (const value of [null, undefined, [], {}, { error: { message: 'provider-token' } }]) invalid(value);
  const input = copy(fixture());
  Object.defineProperty(input.transactionResult, 'transaction', {
    enumerable: true, get() { throw Error('provider-token-and-private-response'); },
  });
  invalid(input);
  const inherited = copy(fixture()); inherited.transactionResult.meta = Object.create({ err: null }); invalid(inherited);
  const unknown = copy(fixture()); unknown.networkVerified = true; invalid(unknown);
});

test('receipt verification never signs, creates keys, calls fetch or mutates the saved input', t => {
  const input = fixture(); const before = JSON.stringify(input);
  const blocked = () => { throw Error('Unexpected network or signing operation'); };
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(Keypair, 'generate', blocked);
  t.mock.method(Keypair, 'fromSeed', blocked);
  t.mock.method(Keypair, 'fromSecretKey', blocked);
  t.mock.method(VersionedTransaction.prototype, 'sign', blocked);
  assert.equal(verifyFinalizedReceipt(input).signature, input.signed.signature);
  assert.equal(JSON.stringify(input), before);
});

function failedFixture() {
  const input = fixture(), err = { InstructionError: [0, 'InvalidArgument'] };
  input.statusResult.value[0].err = err; input.statusResult.value[0].status = { Err: err };
  input.transactionResult.meta.err = err;
  return { transactionBase64: input.signed.transactionBase64, statusResult: input.statusResult, transactionResult: input.transactionResult };
}
test('finalized failure binds every signed byte and matching modern and legacy errors', () => {
  const input = failedFixture(), result = verifyFinalizedFailedTransaction(input);
  assert.equal(result.slot, 55000); assert.equal(result.contextSlot, 55002);
  assert.match(result.errorSha256, /^[0-9a-f]{64}$/); assert.equal('err' in result, false);
  assert.ok(Object.isFrozen(result));
  delete input.statusResult.value[0].status; assert.deepEqual(verifyFinalizedFailedTransaction(input), result);
});
test('success, absence, partial finality, conflicting errors, different bytes and invalid signatures do not prove failure', () => {
  const edits = [
    x => { x.statusResult.value[0] = null; }, x => { x.transactionResult = null; },
    x => { x.statusResult.value[0].err = null; }, x => { x.transactionResult.meta.err = null; },
    x => { x.statusResult.value[0].confirmationStatus = 'confirmed'; },
    x => { x.statusResult.value[0].confirmations = 0; }, x => { x.transactionResult.slot++; },
    x => { x.statusResult.context.slot = 54999; }, x => { x.transactionResult.meta.err = 'AccountInUse'; },
    x => { x.statusResult.value[0].status = { Ok: null }; },
    x => { x.transactionResult.transaction[0] = fixture().request.transactionBase64; },
    x => { const b = Buffer.from(x.transactionBase64, 'base64'); b[1] ^= 1; x.transactionBase64 = b.toString('base64'); x.transactionResult.transaction[0] = x.transactionBase64; },
    ...[{}, [], false, '', 0, { a: 1, b: 2 }].map(err => x => {
      x.statusResult.value[0].err = err; x.statusResult.value[0].status = { Err: err }; x.transactionResult.meta.err = err;
    }),
  ];
  for (const edit of edits) { const input = failedFixture(); edit(input);
    assert.throws(() => verifyFinalizedFailedTransaction(input), e => e.code === 'DEPLOYMENT_RECEIPT_INVALID'); }
});
