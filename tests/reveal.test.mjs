import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { Key, MPL_CORE_PROGRAM_ID, getUpdateV1InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { getAssetV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { devnetUmi, SITE } from '../solana/builders.mjs';
import { prepareReveal, validateRevealMap, assertRevealTime, createRevealSession, inspectRevealItem } from '../solana/reveal.mjs';

// Synthetic CID and metadata only; no final artwork or private collection data.
const root = 'bafkreigh2akiscaildcw453w5q3khyivcxkbkx5dw6rhp5v5y3s5qbx5pa';
const map = Array.from({ length: 10000 }, (_, index) => {
  const id = String(index).padStart(4, '0');
  return { index, name: `CoolBears #${id}`, uri: `ipfs://${root}/metadata/${id}.json` };
});
const commitment = { version: 'solana-20260918', algorithm: 'SHA-256', earliestRevealDate: '2027-01-01', items: 10000,
  hash: createHash('sha256').update(JSON.stringify(map)).digest('hex') };
const revealAt = '2027-01-02T12:00:00Z';
const time = Date.parse(revealAt) / 1000;
function fixture() {
  const umi = devnetUmi().use(signerIdentity(generateSigner(devnetUmi())));
  const collection = generateSigner(umi).publicKey;
  const assets = [generateSigner(umi).publicKey, generateSigner(umi).publicKey];
  const holder = generateSigner(umi).publicKey; // NFT holder need not be the update authority.
  const plan = prepareReveal({ map, commitment, collection, authority: umi.identity.publicKey,
    assignments: assets.map((asset, index) => ({ asset, index })) });
  const journal = { planId: plan.id, cluster: 'devnet' }, saves = [];
  const revealed = new Set(); let sends = 0;
  umi.rpc.getAccount = async (address, options) => {
    assert.equal(options.commitment, 'finalized');
    let data;
    if (address === collection) data = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1,
      updateAuthority: umi.identity.publicKey, name: 'CoolBears', uri: `${SITE}/metadata/collection.json`, numMinted: 2, currentSize: 2 });
    else {
      const index = assets.indexOf(address); assert.ok(index >= 0);
      const id = String(index).padStart(4, '0');
      data = getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1, owner: holder,
        updateAuthority: { __kind: 'Collection', fields: [collection] }, seq: null,
        name: revealed.has(address) ? map[index].name : `CoolBears #${id} — Hidden Bear`,
        uri: revealed.has(address) ? map[index].uri : `${SITE}/metadata/hidden/${id}.json` });
    }
    return { exists: true, publicKey: address, data, executable: false, owner: MPL_CORE_PROGRAM_ID, lamports: { basisPoints: 1n }, rentEpoch: 0n };
  };
  umi.rpc.getLatestBlockhash = async () => ({ blockhash: collection, lastValidBlockHeight: 100n });
  umi.rpc.call = async method => {
    if (method === 'getSlot') return 200;
    if (method === 'getBlockTime') return time;
    if (method === 'getBlockHeight') return 101;
    if (method === 'getSignatureStatuses') return { context: { slot: 200 }, value: [{ confirmationStatus: 'finalized', err: null }] };
    throw Error(method);
  };
  umi.rpc.sendTransaction = async tx => {
    sends++;
    assert.equal(saves.at(-1).pending.asset, journal.pending.asset);
    const instruction = tx.message.instructions[0];
    const [data] = getUpdateV1InstructionDataSerializer().deserialize(instruction.data);
    assert.equal(data.newUpdateAuthority.__option, 'None');
    assert.equal(data.newName.value, map[assets.indexOf(journal.pending.asset)].name);
    revealed.add(journal.pending.asset);
    return tx.signatures[0];
  };
  umi.rpc.confirmTransaction = async () => ({ value: { err: null } });
  const persist = async state => { saves.push(state); };
  return { umi, plan, journal, saves, revealed, assets, persist, sends: () => sends,
    session: () => createRevealSession(umi, plan, journal, persist) };
}

test('All 10000 rows match commitment; tampering, duplicate assets/indices rejected', () => {
  assert.equal(validateRevealMap(map, commitment).length, 10000);
  const bad = structuredClone(map); bad[123].uri = bad[124].uri;
  assert.throws(() => validateRevealMap(bad, commitment), /commitment/);
  const f = fixture();
  for (const assignments of [[{ index: 0, asset: f.assets[0] }, { index: 0, asset: f.assets[1] }],
    [{ index: 0, asset: f.assets[0] }, { index: 1, asset: f.assets[0] }]]) {
    assert.throws(() => prepareReveal({ map, commitment, collection: f.plan.collection, authority: f.plan.authority, assignments }), /Duplicate/);
  }
});

test('Date guard requires explicit time and finalized chain time, with no earlier bypass', () => {
  for (const date of [undefined, '2027-01-01', '2026-12-31T23:59:59Z', '2027-02-30T00:00:00Z'])
    assert.throws(() => assertRevealTime(date, time));
  for (const t of [null, NaN, time - 1]) assert.throws(() => assertRevealTime(revealAt, t));
  assert.doesNotThrow(() => assertRevealTime(revealAt, time));
});

test('Preview builds real unsigned transactions; run changes only metadata and repeat sends zero', async () => {
  const f = fixture(), session = f.session();
  const preview = await session.preview();
  assert.equal(preview.length, 2); assert.ok(preview.every(row => row.bytes <= 1232 && row.status === 'hidden'));
  assert.equal(f.sends(), 0); assert.equal(f.saves.length, 0);
  assert.deepEqual(await session.run({ revealAt }), { complete: 2 });
  assert.equal(f.sends(), 2); assert.equal(f.journal.pending, undefined);
  await f.session().run({ revealAt }); assert.equal(f.sends(), 2);
});

test('Lost response resumes after finalized account proof, skipping the first NFT', async () => {
  const f = fixture(), send = f.umi.rpc.sendTransaction;
  f.umi.rpc.sendTransaction = async tx => { await send(tx); throw Error('Lost response'); };
  await assert.rejects(f.session().run({ revealAt }), /Lost response/);
  assert.ok(f.journal.pending.signature);
  f.umi.rpc.sendTransaction = send;
  await f.session().run({ revealAt });
  assert.equal(f.sends(), 2); assert.equal(f.journal.pending, undefined);
});

test('Success status with stale hidden account blocks retry; finalized absence after expiry permits it', async () => {
  const f = fixture();
  f.journal.pending = { asset: f.assets[0], signature: 'test', lastValidBlockHeight: 100 };
  await assert.rejects(f.session().run({ revealAt }), /unresolved/); assert.equal(f.sends(), 0);
  const call = f.umi.rpc.call;
  f.umi.rpc.call = async method => method === 'getSignatureStatuses' ? { context: { slot: 200 }, value: [null] } : call(method);
  await f.session().run({ revealAt }); assert.equal(f.sends(), 2);
});

test('No broadcast on early date, cancellation, persistence failure or mainnet', async () => {
  const early = fixture();
  await assert.rejects(early.session().run({ revealAt: '2028-01-01T00:00:00Z' }), /not arrived/);
  assert.equal(early.sends(), 0);
  const cancelled = fixture(); cancelled.umi.identity.signTransaction = async () => { throw Error('Cancelled'); };
  await assert.rejects(cancelled.session().run({ revealAt }), /Cancelled/); assert.equal(cancelled.sends(), 0);
  const failed = fixture();
  await assert.rejects(createRevealSession(failed.umi, failed.plan, failed.journal, async () => { throw Error('Disk full'); }).run({ revealAt }), /Disk full/);
  assert.equal(failed.sends(), 0);
  failed.umi.rpc.getEndpoint = () => 'https://api.mainnet-beta.solana.com';
  assert.throws(() => failed.session(), /Devnet only/);
});

test('Wrong collection, authority, metadata, or journal stops operation before signing', async () => {
  const f = fixture();
  f.journal.planId = 'other'; assert.throws(() => f.session(), /Journal/);
  f.journal.planId = f.plan.id;
  const get = f.umi.rpc.getAccount;
  f.umi.rpc.getAccount = async (address, options) => {
    const account = await get(address, options);
    if (address === f.assets[0]) account.data = getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1,
      owner: f.plan.authority, updateAuthority: { __kind: 'Collection', fields: [f.assets[1]] },
      name: 'Unexpected', uri: 'https://example.invalid', seq: null });
    return account;
  };
  await assert.rejects(f.session().run({ revealAt }), /expected collection/); assert.equal(f.sends(), 0);
});

 test('Metadata mismatch and changed authority are rejected independently', () => {
  const f = fixture(), item = f.plan.items[0];
  const collection = { publicKey: f.plan.collection, updateAuthority: f.plan.authority, header: { owner: MPL_CORE_PROGRAM_ID } };
  const asset = { publicKey: item.asset, header: { owner: MPL_CORE_PROGRAM_ID }, updateAuthority: { type: 'Collection', address: f.plan.collection }, name: 'Unexpected', uri: item.uri };
  assert.throws(() => inspectRevealItem(f.plan, item, collection, asset), /Unexpected NFT metadata/);
  assert.throws(() => inspectRevealItem(f.plan, item, { ...collection, updateAuthority: f.assets[1] }, asset), /authority mismatch/);
  assert.throws(() => inspectRevealItem(f.plan, item, collection, { ...asset, header: { owner: f.assets[1] } }), /not owned/);
});
