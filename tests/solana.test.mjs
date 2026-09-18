import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigner, signerIdentity, sol } from '@metaplex-foundation/umi';
import { getCreateCollectionV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { getInitializeCandyMachineInstructionDataSerializer, getAddConfigLinesInstructionDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { devnetUmi, assertDevnet, collectionBuilder, testMachineBuilder, testItemsBuilder, testMintBuilder } from '../solana/builders.mjs';

function setup() {
  const umi = devnetUmi(); umi.use(signerIdentity(generateSigner(umi)));
  umi.rpc.getRent = async () => sol(0.01); // Offline size/serialization check; not a network rent estimate.
  return { umi, collection: generateSigner(umi), machine: generateSigner(umi), asset: generateSigner(umi) };
}
test('Devnet workflow rejects mainnet endpoint before building a transaction', () => {
  const { umi } = setup(); umi.rpc.getEndpoint = () => 'https://api.mainnet-beta.solana.com';
  assert.throws(() => assertDevnet(umi), /Devnet only/);
});
test('Collection instruction encodes approved metadata and 7% royalties for connected owner', () => {
  const { umi, collection } = setup();
  const b = collectionBuilder(umi, collection);
  const [data] = getCreateCollectionV2InstructionDataSerializer().deserialize(b.getInstructions()[0].data);
  assert.equal(data.name, 'CoolBears');
  assert.equal(data.uri, 'https://coolbears-nfts.com/metadata/collection.json');
  const royalty = data.plugins.value[0].plugin;
  assert.equal(royalty.__kind, 'Royalties');
  assert.equal(royalty.fields[0].basisPoints, 700);
  assert.equal(royalty.fields[0].creators[0].address, umi.identity.publicKey);
});
test('Test machine is two mutable assets with sequential exact names and guarded mint authority', async () => {
  const { umi, collection, machine } = setup();
  const builder = await testMachineBuilder(umi, machine, collection.publicKey);
  const ix = builder.getInstructions();
  const [data] = getInitializeCandyMachineInstructionDataSerializer().deserialize(ix[1].data);
  assert.equal(data.itemsAvailable, 2n);
  assert.equal(data.isMutable, true);
  assert.equal(data.configLineSettings.value.isSequential, true);
  assert.equal(data.configLineSettings.value.prefixName, 'CoolBears #');
  assert.equal(ix.at(-1).programId, 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ');
  // Address-gate data contains the connected wallet's actual 32 bytes.
  const { publicKey } = await import('@metaplex-foundation/umi/serializers');
  assert.ok(Buffer.from(ix[2].data).includes(Buffer.from(publicKey().serialize(umi.identity.publicKey))));
});
test('Config lines preserve #0000/#0001 padding and point only to hidden metadata', () => {
  const { umi, machine } = setup();
  const [data] = getAddConfigLinesInstructionDataSerializer().deserialize(testItemsBuilder(umi, machine.publicKey).getInstructions()[0].data);
  assert.deepEqual(data.configLines, [{ name: '0000 — Hidden Bear', uri: '0000.json' }, { name: '0001 — Hidden Bear', uri: '0001.json' }]);
  assert.equal(new TextEncoder().encode(data.configLines[0].name).length, 20);
});
test('Each owner operation fits a real 1232-byte Solana transaction without splitting', async () => {
  const { umi, collection, machine, asset } = setup();
  const builders = [collectionBuilder(umi, collection), await testMachineBuilder(umi, machine, collection.publicKey), testItemsBuilder(umi, machine.publicKey), testMintBuilder(umi, machine.publicKey, collection.publicKey, asset)];
  for (const builder of builders) assert.ok(builder.getTransactionSize(umi) <= 1232);
});
