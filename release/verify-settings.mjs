import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { generateSigner, signerIdentity, lamports } from '@metaplex-foundation/umi';
import { mplCore, getCreateCollectionV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, getInitializeCandyMachineInstructionDataSerializer,
  getCandyGuardDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCreateCandyGuardInstructionDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/createCandyGuard.js';
import { policy, CLOSED_UNTIL, royalties, closedGuards, collectionBuilder, machineBuilder } from './settings.mjs';

const checks = [];
const umi = createUmi('http://127.0.0.1:8899').use(mplCore()).use(mplCandyMachine());
const owner = generateSigner(umi);
umi.use(signerIdentity(owner));
// Offline construction: only rent is supplied. This is not a network simulation.
umi.rpc.getRent = async () => lamports(1000000);
const collection = generateSigner(umi);
const ix = collectionBuilder(umi, collection, { owner: owner.publicKey }).items[0].instruction;
const [decodedCollection] = getCreateCollectionV2InstructionDataSerializer().deserialize(ix.data);
assert.equal(decodedCollection.name, policy.collectionName);
assert.equal(decodedCollection.plugins.value[0].plugin.__kind, 'Royalties');
assert.equal(decodedCollection.plugins.value[0].plugin.fields[0].basisPoints, 700);
assert.equal(royalties(owner.publicKey).creators[0].percentage, 100);
checks.push('collection name, owner and 700-bps royalties serialized by official SDK');

const commitment = createHash('sha256').update('offline test fixture, not production reveal').digest();
const builder = await machineBuilder(umi, generateSigner(umi), collection.publicKey, {
  owner: owner.publicKey, treasury: owner.publicKey, commitment,
  uri: 'https://example.com/pre-reveal/$ID+1$.json',
});
const machineIx = builder.items.find(i => i.instruction.programId === 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J');
const [machine] = getInitializeCandyMachineInstructionDataSerializer().deserialize(machineIx.instruction.data);
assert.equal(machine.itemsAvailable, 9999n);
assert.equal(machine.isMutable, true);
assert.equal(machine.configLineSettings.__option, 'None');
assert.deepEqual(Buffer.from(machine.hiddenSettings.value.hash), commitment);
checks.push('9999 public items, mutable hidden metadata and exact 32-byte commitment');

const guardIx = builder.items.find(i => i.instruction.programId === 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ');
const [guardInput] = getCreateCandyGuardInstructionDataSerializer().deserialize(guardIx.instruction.data);
const [guardData] = getCandyGuardDataSerializer(umi, umi.programs.get('mplCoreCandyGuard')).deserialize(guardInput.data);
const guards = guardData.guards;
assert.equal(guards.solPayment.value.lamports.basisPoints, 500000000n);
assert.equal(guards.startDate.value.date, CLOSED_UNTIL);
assert.ok(CLOSED_UNTIL > BigInt(Math.floor(Date.now() / 1000)));
assert.equal(guards.mintLimit.__option, 'None');
assert.equal(guardData.groups.length, 0);
checks.push('0.5 SOL payment, sales closed, no lifetime wallet limit');

const signed = await builder.useLegacyVersion().setBlockhash({
  blockhash: generateSigner(umi).publicKey, lastValidBlockHeight: 1,
}).buildAndSign(umi);
assert.ok(umi.transactions.serialize(signed).length <= 1232, 'Transaction must fit packet size');
for (let i = 0; i < signed.message.header.numRequiredSignatures; i++) {
  assert.equal(umi.eddsa.verify(signed.serializedMessage, signed.signatures[i], signed.message.accounts[i]), true);
}
checks.push('complete machine transaction fits Solana packet size and all signatures verify');

await assert.rejects(machineBuilder(umi, generateSigner(umi), collection.publicKey, {
  owner: owner.publicKey, commitment: new Uint8Array(31), uri: 'https://example.com/hidden.json',
}), /32-byte/);
await assert.rejects(machineBuilder(umi, generateSigner(umi), collection.publicKey, {
  owner: policy.owner, commitment, uri: 'https://example.com/hidden.json',
}), /authority must sign/);
checks.push('invalid commitment and wrong authority rejected before signing');

for (const name of ['collection', '0000']) {
  const json = JSON.parse(await readFile(new URL(`../metadata/${name}.json`, import.meta.url)));
  assert.equal(json.description, name === 'collection' ? policy.collectionDescription : policy.hiddenDescription);
  if (name === '0000') {
    for (const key of ['attributes', 'rank', 'rarity']) assert.equal(json[key], undefined);
  }
}
checks.push('approved descriptions preserved; hidden placeholder has no private traits');
await mkdir(new URL('./reports/', import.meta.url), { recursive: true });
const report = { date: new Date().toISOString(), scope: 'offline SDK construction only', passed: true, checks };
await writeFile(new URL('./reports/settings.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
