// Offline cryptographic fixtures only. These deterministic keys have no role in
// the deployed collection; tests never connect a wallet, contact RPC or send SOL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createSigningRequest, verifySigningResponse } from '../deployment/signing.mjs';

const fixtureKey = label => Keypair.fromSeed(createHash('sha256').update(`offline-deployment-signing-test:${label}`).digest());
const owner = fixtureKey('owner');
const extra = fixtureKey('ephemeral-1');
const secondExtra = fixtureKey('ephemeral-2');
const other = fixtureKey('different-owner');
const blockhash = fixtureKey('blockhash').publicKey.toBase58();
const toBase64 = transaction => Buffer.from(transaction.serialize()).toString('base64');
const parse = text => VersionedTransaction.deserialize(Buffer.from(text, 'base64'));
const invalid = callback => assert.throws(callback, error => error.code === 'DEPLOYMENT_SIGNING_INVALID');

function fixture(version = 0, extraSigners = [extra]) {
  const instructions = extraSigners.length
    ? extraSigners.map(keypair => SystemProgram.createAccount({ fromPubkey: owner.publicKey,
      newAccountPubkey: keypair.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }))
    : [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: other.publicKey, lamports: 1 })];
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash, instructions });
  const transaction = new VersionedTransaction(version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
  if (extraSigners.length) transaction.sign(extraSigners);
  const input = { deploymentId: 'offline-deployment', stepId: 'collection-create', attempt: 1,
    cluster: 'devnet', owner: owner.publicKey.toBase58(), transactionBase64: toBase64(transaction), lastValidBlockHeight: 123456 };
  return { input, transaction, extraSigners };
}
function signedResponse(input, change = () => {}, signers = [owner]) {
  const transaction = parse(input.transactionBase64);
  change(transaction);
  transaction.sign(signers);
  return { transactionBase64: toBase64(transaction) };
}

for (const version of [0, 'legacy']) {
  test(`${version}: partial handoff accepts only the owner signature and preserves the ephemeral signature`, () => {
    const { input, transaction } = fixture(version);
    const original = JSON.stringify(input);
    const request = createSigningRequest(input);
    const response = signedResponse(input);
    const receipt = verifySigningResponse(JSON.parse(JSON.stringify(request)), response);
    assert.equal(request.kind, 'coolbears-deployment-signing-request');
    assert.equal(request.version, 1);
    assert.equal(request.transactionBase64, input.transactionBase64);
    assert.equal(request.blockhash, blockhash);
    assert.equal(request.messageSha256, createHash('sha256').update(transaction.message.serialize()).digest('hex'));
    assert.deepEqual(request.requiredSigners, [owner.publicKey.toBase58(), extra.publicKey.toBase58()]);
    assert.deepEqual(receipt, { transactionBase64: response.transactionBase64,
      signature: base58.deserialize(parse(response.transactionBase64).signatures[0])[0],
      blockhash, messageSha256: request.messageSha256, requiredSigners: request.requiredSigners });
    assert.deepEqual(parse(response.transactionBase64).signatures[1], transaction.signatures[1]);
    assert.equal(JSON.stringify(input), original);
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request.requiredSigners) && Object.isFrozen(receipt));
    assert.equal('readyToSubmit' in receipt, false);
    assert.equal('networkVerified' in receipt, false);
  });

  test(`${version}: owner-only and multiple ephemeral signer handoffs are supported`, () => {
    for (const signers of [[], [extra, secondExtra]]) {
      const { input } = fixture(version, signers);
      const request = createSigningRequest(input);
      assert.equal(request.requiredSigners.length, signers.length + 1);
      const receipt = verifySigningResponse(request, signedResponse(input));
      assert.equal(parse(receipt.transactionBase64).version, version);
      assert.equal(parse(receipt.transactionBase64).signatures.length, signers.length + 1);
    }
  });
}

test('handoff refuses the wrong payer, a pre-existing owner signature and missing or corrupt ephemeral signatures', () => {
  const { input } = fixture();
  invalid(() => createSigningRequest({ ...input, owner: other.publicKey.toBase58() }));
  invalid(() => createSigningRequest({ ...input, ...signedResponse(input) }));
  for (const change of [tx => tx.signatures[1].fill(0), tx => { tx.signatures[1][50] ^= 1; }]) {
    const transaction = parse(input.transactionBase64); change(transaction);
    invalid(() => createSigningRequest({ ...input, transactionBase64: toBase64(transaction) }));
  }
});

test('owner reply must cryptographically verify, even if its signature is nonzero', () => {
  const { input } = fixture(); const request = createSigningRequest(input);
  invalid(() => verifySigningResponse(request, { transactionBase64: input.transactionBase64 }));
  const response = signedResponse(input);
  const transaction = parse(response.transactionBase64);
  transaction.signatures[0][63] ^= 1;
  invalid(() => verifySigningResponse(request, { transactionBase64: toBase64(transaction) }));
  const wrongMessage = signedResponse(input, tx => { tx.message.recentBlockhash = other.publicKey.toBase58(); });
  transaction.signatures[0] = parse(wrongMessage.transactionBase64).signatures[0];
  invalid(() => verifySigningResponse(request, { transactionBase64: toBase64(transaction) }));
});

test('wallet dropping, replacing or corrupting an ephemeral signature is refused without repair', () => {
  const { input } = fixture(0, [extra, secondExtra]); const request = createSigningRequest(input);
  for (const change of [tx => tx.signatures[1].fill(0), tx => { tx.signatures[1] = tx.signatures[2].slice(); }, tx => { tx.signatures[2][0] ^= 1; }]) {
    const response = signedResponse(input, change);
    invalid(() => verifySigningResponse(request, response));
    assert.equal(request.transactionBase64, input.transactionBase64);
  }
});

test('changed blockhash, instruction data or destination fails even with valid signatures for the new message', () => {
  const { input } = fixture(); const request = createSigningRequest(input);
  const changes = [
    tx => { tx.message.recentBlockhash = other.publicKey.toBase58(); },
    tx => { tx.message.compiledInstructions[0].data[4] ^= 1; },
    tx => { tx.message.compiledInstructions[0].accountKeyIndexes[1] = 0; },
  ];
  for (const change of changes) invalid(() => verifySigningResponse(request, signedResponse(input, change, [owner, extra])));
});

test('changed fee payer and signer order are refused', () => {
  const { input } = fixture(); const request = createSigningRequest(input);
  invalid(() => verifySigningResponse(request, signedResponse(input,
    tx => { tx.message.staticAccountKeys[0] = other.publicKey; }, [other, extra])));
  invalid(() => verifySigningResponse(request, signedResponse(input,
    tx => { [tx.message.staticAccountKeys[0], tx.message.staticAccountKeys[1]] = [tx.message.staticAccountKeys[1], tx.message.staticAccountKeys[0]]; }, [extra, owner])));
  const ownerOnly = fixture(0, []).input;
  invalid(() => verifySigningResponse(request, signedResponse(ownerOnly)));
});

test('derived request fields are revalidated after JSON persistence', () => {
  const { input } = fixture(); const request = createSigningRequest(input); const response = signedResponse(input);
  for (const changes of [
    { version: 2 }, { kind: 'other' }, { messageSha256: '0'.repeat(64) },
    { blockhash: other.publicKey.toBase58() }, { requiredSigners: [...request.requiredSigners].reverse() },
    { requiredSigners: request.requiredSigners.slice(0, 1) }, { requiredSigners: null },
    { requiredSigners: new Array(request.requiredSigners.length) },
    { requiredSigners: Object.assign([...request.requiredSigners], { extra: true }) },
    { owner: other.publicKey.toBase58() }, { transactionBase64: response.transactionBase64 },
    { unexpected: true }, { attempt: 0 }, { lastValidBlockHeight: 0 },
  ]) invalid(() => verifySigningResponse({ ...request, ...changes }, response));
  const missing = { ...request }; delete missing.cluster;
  invalid(() => verifySigningResponse(missing, response));
});

test('strict input schema rejects extra fields, getters and malformed attempt, labels, IDs or addresses', () => {
  const { input } = fixture();
  for (const changes of [
    { unexpected: true }, { deploymentId: '../secret' }, { deploymentId: '' }, { stepId: 'x'.repeat(65) },
    { attempt: 1.5 }, { attempt: '1' }, { attempt: Number.MAX_SAFE_INTEGER + 1 },
    { cluster: 'mainnet' }, { owner: 'invalid' }, { lastValidBlockHeight: -1 }, { lastValidBlockHeight: '123456' },
  ]) invalid(() => createSigningRequest({ ...input, ...changes }));
  invalid(() => createSigningRequest(null));
  invalid(() => createSigningRequest([]));
  const missing = { ...input }; delete missing.owner; invalid(() => createSigningRequest(missing));
  const getter = { ...input };
  Object.defineProperty(getter, 'owner', { enumerable: true, get() { throw Error('Getter must not run'); } });
  invalid(() => createSigningRequest(getter));
  const request = createSigningRequest(input);
  invalid(() => verifySigningResponse(request, { ...signedResponse(input), sent: true }));
});

test('both cluster values are offline labels and do not authorize or attest to a network', () => {
  const { input } = fixture();
  for (const cluster of ['devnet', 'mainnet-beta']) {
    const request = createSigningRequest({ ...input, cluster });
    assert.equal(request.cluster, cluster);
    assert.equal(verifySigningResponse(request, signedResponse(input)).messageSha256, request.messageSha256);
  }
});

test('base64, packet size and wire serialization must be canonical at both boundaries', () => {
  const { input } = fixture(); const request = createSigningRequest(input);
  const raw = Buffer.from(input.transactionBase64, 'base64');
  const malformed = [
    '', ` ${input.transactionBase64}`, `${input.transactionBase64}\n`, `${input.transactionBase64}=`,
    'AA-_', Buffer.alloc(1233).toString('base64'), Buffer.alloc(20).toString('base64'),
    Buffer.concat([raw, Buffer.from([0])]).toString('base64'),
    Buffer.concat([Buffer.from([raw[0] | 0x80, 0]), raw.subarray(1)]).toString('base64'),
  ];
  for (const transactionBase64 of malformed) {
    invalid(() => createSigningRequest({ ...input, transactionBase64 }));
    invalid(() => verifySigningResponse(request, { transactionBase64 }));
  }
  const unsupported = Buffer.from(raw); unsupported[1 + 64 * 2] = 0x81;
  invalid(() => createSigningRequest({ ...input, transactionBase64: unsupported.toString('base64') }));
});

test('invalid account headers, duplicate accounts and account indexes fail closed', () => {
  const { input } = fixture();
  for (const change of [
    tx => { tx.message.header.numReadonlySignedAccounts = 2; },
    tx => { tx.message.header.numReadonlyUnsignedAccounts = 255; },
    tx => { tx.message.staticAccountKeys[1] = tx.message.staticAccountKeys[0]; },
    tx => { tx.message.compiledInstructions[0].programIdIndex = 0; },
    tx => { tx.message.compiledInstructions[0].programIdIndex = 255; },
    tx => { tx.message.compiledInstructions[0].accountKeyIndexes[0] = 255; },
  ]) {
    const transaction = parse(input.transactionBase64); change(transaction);
    invalid(() => createSigningRequest({ ...input, transactionBase64: toBase64(transaction) }));
  }
});

test('address lookup table messages are explicitly excluded without fetching accounts', () => {
  const { input } = fixture(0, []);
  const lookup = new AddressLookupTableAccount({ key: extra.publicKey,
    state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0,
      authority: undefined, addresses: [other.publicKey] } });
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: other.publicKey, lamports: 1 })] })
    .compileToV0Message([lookup]);
  assert.equal(message.addressTableLookups.length, 1);
  invalid(() => createSigningRequest({ ...input, transactionBase64: toBase64(new VersionedTransaction(message)) }));
});

test('small-order public keys and forged identity signatures are rejected', () => {
  const { input } = fixture(0, []);
  const identity = new Uint8Array(32); identity[0] = 1;
  const transaction = parse(input.transactionBase64);
  transaction.message.staticAccountKeys[0] = new PublicKey(identity);
  invalid(() => createSigningRequest({ ...input, owner: new PublicKey(identity).toBase58(), transactionBase64: toBase64(transaction) }));
  const request = createSigningRequest(input);
  const response = parse(input.transactionBase64);
  response.signatures[0].fill(0); response.signatures[0][0] = 1;
  invalid(() => verifySigningResponse(request, { transactionBase64: toBase64(response) }));
});

test('verification paths neither sign, generate keys nor access fetch', t => {
  const { input } = fixture(); const response = signedResponse(input);
  const blocked = () => { throw Error('Unexpected signing, key creation or network access'); };
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(Keypair, 'generate', blocked);
  t.mock.method(Keypair, 'fromSeed', blocked);
  t.mock.method(Keypair, 'fromSecretKey', blocked);
  t.mock.method(VersionedTransaction.prototype, 'sign', blocked);
  const request = createSigningRequest(input);
  assert.equal(verifySigningResponse(request, response).transactionBase64, response.transactionBase64);
});
