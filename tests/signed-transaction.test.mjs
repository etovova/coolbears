import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { validateSignedTransaction } from '../devnet/signed-transaction.mjs';
import { settings as S } from '../devnet/settings.mjs';

const rpcFixture = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
const invalid = { code: 'SIGNED_TRANSACTION_INVALID' };
async function mintFixture() {
  // These keypairs exist only inside this offline test process. No owner key,
  // remote endpoint, real wallet or blockchain submission is used.
  const owner = Keypair.generate();
  const address = owner.publicKey.toBase58();
  const umi = createUmi(S.rpc).use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(publicKey(address))));
  const asset = generateSigner(umi);
  const blockhash = rpcFixture.getLatestBlockhash.value;
  const tx = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
    candyMachine: publicKey(S.machine), candyGuard: publicKey(S.guard), collection: publicKey(S.collection), asset, owner: publicKey(address),
    mintArgs: { solPayment: { destination: publicKey(S.owner) } },
  })).setBlockhash(blockhash).buildAndSign(umi);
  const prepared = umi.transactions.serialize(tx);
  const signed = VersionedTransaction.deserialize(prepared);
  signed.sign([owner]);
  const operation = { version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection, owner: address, asset: asset.publicKey, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, stage: 'wallet-pending', signature: null };
  return { owner, asset, umi, prepared, signed: signed.serialize(), operation, options: { expectedOwner: address } };
}

test('signed mint validates exact SDK bytes and both signatures without mutating either input', async () => {
  const f = await mintFixture();
  const beforePrepared = new Uint8Array(f.prepared), beforeSigned = new Uint8Array(f.signed);
  const result = validateSignedTransaction(f.prepared, f.signed, f.operation, f.options);
  assert.deepEqual(result.bytes, f.signed);
  assert.notEqual(result.bytes, f.signed);
  assert.notEqual(result.bytes.buffer, f.signed.buffer);
  assert.equal(result.signature, base58.deserialize(VersionedTransaction.deserialize(f.signed).signatures[0])[0]);
  assert.deepEqual(f.prepared, beforePrepared);
  assert.deepEqual(f.signed, beforeSigned);
  f.signed.fill(0);
  assert.deepEqual(result.bytes, beforeSigned, 'Returned bytes remain independent of provider buffers');
});

test('production default accepts only the configured owner and coordinates must match', async () => {
  const f = await mintFixture();
  assert.throws(() => validateSignedTransaction(f.prepared, f.signed, f.operation), invalid);
  for (const change of [{ owner: S.owner }, { asset: S.machine }, { blockhash: S.machine }, { asset: f.operation.owner }, { blockhash: 'invalid' }]) {
    assert.throws(() => validateSignedTransaction(f.prepared, f.signed, { ...f.operation, ...change }, f.options), invalid);
  }
});

test('changed instruction is rejected even when the wallet returns valid replacement signatures', async () => {
  const f = await mintFixture();
  const changed = VersionedTransaction.deserialize(f.signed);
  changed.message.compiledInstructions[0].data[1] ^= 1;
  changed.sign([f.owner]);
  changed.signatures[1] = f.umi.eddsa.sign(changed.message.serialize(), f.asset);
  assert.equal(f.umi.eddsa.verify(changed.message.serialize(), changed.signatures[0], f.operation.owner), true);
  assert.equal(f.umi.eddsa.verify(changed.message.serialize(), changed.signatures[1], f.operation.asset), true);
  assert.throws(() => validateSignedTransaction(f.prepared, changed.serialize(), f.operation, f.options), /содержимое/);
});

test('missing, corrupted or replaced owner and asset signatures are rejected', async () => {
  const f = await mintFixture();
  assert.throws(() => validateSignedTransaction(f.prepared, f.prepared, f.operation, f.options), invalid);
  for (const index of [0, 1]) {
    for (const zero of [false, true]) {
      const changed = VersionedTransaction.deserialize(f.signed);
      if (zero) changed.signatures[index].fill(0);
      else changed.signatures[index][0] ^= 1;
      assert.throws(() => validateSignedTransaction(f.prepared, changed.serialize(), f.operation, f.options), invalid);
    }
  }
  const prepared = VersionedTransaction.deserialize(f.prepared);
  const signed = VersionedTransaction.deserialize(f.signed);
  prepared.signatures[1][0] ^= 1;
  signed.signatures[1].set(prepared.signatures[1]);
  assert.throws(() => validateSignedTransaction(prepared.serialize(), signed.serialize(), f.operation, f.options), /проверить подписи/);
  assert.throws(() => validateSignedTransaction(f.signed, f.signed, f.operation, f.options), /уже содержит подпись/);
});

test('wrong payer, signer order, number of signers and readonly signer are rejected', async () => {
  const f = await mintFixture();
  for (const mutate of [
    tx => { [tx.message.staticAccountKeys[0], tx.message.staticAccountKeys[1]] = [tx.message.staticAccountKeys[1], tx.message.staticAccountKeys[0]]; },
    tx => { tx.message.staticAccountKeys[0] = Keypair.generate().publicKey; },
    tx => { tx.message.header.numReadonlySignedAccounts = 1; },
    tx => { tx.message.header.numRequiredSignatures = 1; tx.signatures = tx.signatures.slice(0, 1); },
    tx => { tx.message.header.numRequiredSignatures = 3; tx.signatures.push(new Uint8Array(64)); },
  ]) {
    const changed = VersionedTransaction.deserialize(f.prepared); mutate(changed);
    assert.throws(() => validateSignedTransaction(changed.serialize(), changed.serialize(), f.operation, f.options), invalid);
  }
});

test('changed blockhash and legacy transactions are rejected', async () => {
  const f = await mintFixture();
  const changed = VersionedTransaction.deserialize(f.signed);
  changed.message.recentBlockhash = S.machine;
  assert.throws(() => validateSignedTransaction(f.prepared, changed.serialize(), f.operation, f.options), /срок/);
  const legacy = new VersionedTransaction(new TransactionMessage({ payerKey: f.owner.publicKey, recentBlockhash: f.operation.blockhash, instructions: [] }).compileToLegacyMessage()).serialize();
  assert.throws(() => validateSignedTransaction(legacy, legacy, f.operation, f.options), /v0/);
});

test('noncanonical encodings, trailing data and oversized or malformed packets are rejected', async () => {
  const f = await mintFixture();
  for (const bytes of [
    new Uint8Array([...f.signed, 0]),
    new Uint8Array([0x82, 0x00, ...f.signed.slice(1)]),
    new Uint8Array(1233), new Uint8Array(), new Uint8Array([0xff]), Array.from(f.signed),
  ]) assert.throws(() => validateSignedTransaction(f.prepared, bytes, f.operation, f.options), invalid);
  for (const bytes of [new Uint8Array([...f.prepared, 0]), new Uint8Array([0x82, 0x00, ...f.prepared.slice(1)])]) {
    assert.throws(() => validateSignedTransaction(bytes, f.signed, f.operation, f.options), invalid);
  }
});
