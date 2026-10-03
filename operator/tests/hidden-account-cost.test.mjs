// Synthetic SDK account encodings only. No private mappings, RPC or signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { some } from '@metaplex-foundation/umi';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { CANDY_MACHINE_HIDDEN_SECTION } from '@metaplex-foundation/mpl-core-candy-machine';
import { getAssetV1AccountDataSerializer as assetSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { policy } from '../prepare.mjs';
import { hiddenAccountFixtures, fixtureRpcAccount as rpc } from './fixtures/hidden-accounts.mjs';
import { createAccountVerifier } from '../deployment/accounts-model.mjs';
import { baseAssetBytes, verifySimulatedMintCost, CORE_CREATE_LAMPORTS } from '../orders/mint-cost.mjs';

const address = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const options = { storageMode: 'hidden-settings', hiddenCommitmentSha256:
  createHash('sha256').update('SYNTHETIC-UNIT-TEST-REVEAL-MAPPING').digest('hex') };
const machine = address(20), collection = address(21);
const { profile, expected, machineAccount, guardAccount, collectionAccount, guard } = hiddenAccountFixtures({
  policy, storageOptions: options, roles: { machine, collection } });
const verifier = createAccountVerifier(policy, options), legacy = createAccountVerifier(policy);
const order = { machine, guard, collection, buyer: policy.owner, ...options };
const check = (value = expected, account = machineAccount(), closedGuard = guardAccount()) =>
  verifier.verifyExpectedAccounts(value, verifier.expectedAccountAddresses(value), [account, closedGuard]);
const mismatch = error => error.code === 'EXPECTED_ACCOUNT_STATE_MISMATCH';
const costMismatch = error => error.checkCode === 'MINT_COST_UNVERIFIED';

test('hidden allocation is exactly 652 bytes, unminted, fully bound to the supplied commitment', () => {
  assert.equal(CANDY_MACHINE_HIDDEN_SECTION, 652);
  assert.equal(profile.machineSpace, 652);
  assert.equal(check(), true);
  for (const altered of [{ ...expected, itemsLoaded: 1 }, { ...expected, machineSpace: 653 },
    { ...expected, hiddenSettings: { ...expected.hiddenSettings, hash: 'f'.repeat(64) } },
    { ...expected, configLineSettings: { prefixName: '', nameLength: 0, prefixUri: '', uriLength: 0, isSequential: true } },
    { ...expected, storageMode: 'config-lines' }, { ...expected, salesOpen: true }]) {
    assert.throws(() => check(altered), mismatch);
  }
  assert.throws(() => check(expected, machineAccount(1)), mismatch);
  assert.throws(() => check(expected, machineAccount(0, {}, 4)), mismatch);
  assert.throws(() => legacy.expectedAccountAddresses(expected), mismatch);
  assert.throws(() => createAccountVerifier(policy, { storageMode: 'hidden-settings' }));
});

test('hidden base rejects different commitment, templates, plugin policy and unexplained bytes', () => {
  for (const hiddenSettings of [
    { ...profile.hiddenSettings, hash: new Uint8Array(32).fill(99) },
    { ...profile.hiddenSettings, hash: new Uint8Array(Buffer.from(profile.hiddenSettings.hash, 'hex')), name: 'CoolBears #$ID$' },
    { ...profile.hiddenSettings, hash: new Uint8Array(Buffer.from(profile.hiddenSettings.hash, 'hex')), uri: `${policy.website}/metadata/hidden-indexed/$ID$.json` },
  ]) assert.throws(() => check(expected, machineAccount(0, { hiddenSettings: some(hiddenSettings) })), mismatch);
  for (const changes of [{ itemsAvailable: 10000n }, { isMutable: false }, { maxEditionSupply: 1n },
    { configLineSettings: some({ prefixName: '', nameLength: 1, prefixUri: '', uriLength: 1, isSequential: true }) }]) {
    assert.throws(() => check(expected, machineAccount(0, changes)), mismatch);
  }
  const dirty = machineAccount(); const bytes = Buffer.from(dirty.data[0], 'base64'); bytes[651] = 1;
  assert.throws(() => check(expected, { ...dirty, data: [bytes.toString('base64'), 'base64'] }), mismatch);
  assert.throws(() => check(expected, machineAccount(), guardAccount(1n)), mismatch);
  assert.throws(() => check(expected, machineAccount(), guardAccount(200000000n, address(22))), mismatch);
});

test('hidden order account checks derive the next exact index without reading config-line state', () => {
  for (const redeemed of [0, 8, 9, 98, 99, 998, 999, 9998, 9999]) {
    const values = [machineAccount(redeemed), guardAccount(), collectionAccount(redeemed)];
    const result = verifier.verifyOrderAccounts(order, values);
    assert.equal(result.itemsRemaining, 9999 - redeemed);
    assert.equal(result.nextMintIndex, redeemed + 1);
    assert.equal(result.itemsRedeemed, redeemed);
  }
  assert.throws(() => verifier.verifyOrderAccounts(order, [machineAccount(10000), guardAccount(), collectionAccount(10000)]), mismatch);
  assert.throws(() => verifier.verifyOrderAccounts({ ...order, hiddenCommitmentSha256: 'f'.repeat(64) },
    [machineAccount(), guardAccount(), collectionAccount(0)]), mismatch);
  const unbound = { ...order }; delete unbound.storageMode;
  assert.throws(() => verifier.verifyOrderAccounts(unbound, [machineAccount(), guardAccount(), collectionAccount(0)]), mismatch);
});

test('hidden mint quotes exact decimal index widths and the buyer funds rent plus Core charge', () => {
  const rent = 123456n;
  for (const index of [1, 9, 10, 99, 100, 999, 1000, 9999]) {
    const bytes = baseAssetBytes(policy, order, index, options);
    const [asset] = assetSerializer().deserialize(bytes);
    assert.equal(asset.name, `CoolBears #${index}`);
    assert.equal(asset.uri, `${policy.website}/metadata/hidden-indexed/${index}.json`);
    assert.equal(asset.owner, order.buyer);
    assert.equal(verifySimulatedMintCost(policy, order,
      [rpc(bytes, MPL_CORE_PROGRAM_ID, Number(rent + CORE_CREATE_LAMPORTS))], rent,
      { ...options, expectedIndex: index }), CORE_CREATE_LAMPORTS);
  }
  assert.equal(baseAssetBytes(policy, order, 10, options).length - baseAssetBytes(policy, order, 9, options).length, 2);
  assert.equal(baseAssetBytes(policy, order, 1000, options).length - baseAssetBytes(policy, order, 999, options).length, 2);
  for (const index of [0, 10000, 1.5, '0001', undefined]) {
    assert.throws(() => baseAssetBytes(policy, order, index, options), costMismatch);
  }
});

test('hidden simulation cannot accept a different index, overfunded asset, extra bytes or unbound mode', () => {
  const rent = 123456n, correct = baseAssetBytes(policy, order, 9, options);
  const account = rpc(correct, MPL_CORE_PROGRAM_ID, Number(rent + CORE_CREATE_LAMPORTS));
  for (const changed of [rpc(baseAssetBytes(policy, order, 10, options), MPL_CORE_PROGRAM_ID, account.lamports),
    { ...account, lamports: account.lamports + 1 }, { ...account, lamports: account.lamports - 1 },
    rpc(Buffer.concat([correct, Buffer.from([0])]), MPL_CORE_PROGRAM_ID, account.lamports),
    { ...account, space: account.space + 1 }, { ...account, owner: address(24) }]) {
    assert.throws(() => verifySimulatedMintCost(policy, order, [changed], rent, { ...options, expectedIndex: 9 }), costMismatch);
  }
  assert.throws(() => verifySimulatedMintCost(policy, order, [account], rent, options), costMismatch);
  assert.throws(() => baseAssetBytes(policy, order), costMismatch);
  assert.throws(() => verifySimulatedMintCost(policy, { ...order, hiddenCommitmentSha256: 'f'.repeat(64) },
    [account], rent, { ...options, expectedIndex: 9 }), costMismatch);
});
