// Source-backed account layout model, NOT a live rent quote or funding advice.
// Canonical intent is rebuilt before accepting a caller's manifest.
import assert from 'node:assert/strict';
import { VersionedTransaction } from '@solana/web3.js';
import { Key, PluginType, getPluginSerializer, getPluginHeaderV1AccountDataSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getPluginRegistryV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData.js';
import { getCreateCandyGuardInstructionDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/createCandyGuard.js';
import { getCandyGuardSize } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/accounts/candyGuard.js';
import { none } from '@metaplex-foundation/umi';
import { validateCanonicalDeploymentManifest } from './intent.mjs';
import corePackage from '../node_modules/@metaplex-foundation/mpl-core/package.json' with { type: 'json' };
import machinePackage from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/package.json' with { type: 'json' };

export const COST_MODEL_REVISION = 'core-1.10.0-cm-0.3.0-20260923';
export const CORE_CREATE_FEE_LAMPORTS = '1500000';
export const COST_SOURCE_COMMITS = Object.freeze({
  core: 'e72d63e4118a0a95ac9b40221e81b19d49e1e102',
  candyMachine: 'ea3620b7436004f62e1e7bc3d69147f4feef2ae0',
});

export async function buildDeploymentCostModel(manifest) {
  assert.equal(corePackage.version, '1.10.0', 'COST_MODEL_SDK_VERSION_CHANGED');
  assert.equal(machinePackage.version, '0.3.0', 'COST_MODEL_SDK_VERSION_CHANGED');
  const plan = await validateCanonicalDeploymentManifest(manifest);
  const [collection, reserve, machine] = plan.steps.map(step => step.expected);
  const base = getCollectionV1AccountDataSerializer().serialize({ key: Key.CollectionV1,
    updateAuthority: plan.roles.owner, name: collection.name, uri: collection.uri, numMinted: 0, currentSize: 0 });
  const royalty = getPluginSerializer().serialize({ __kind: 'Royalties', fields: [{
    basisPoints: collection.royaltyBasisPoints, creators: [{ address: collection.royaltyRecipient, percentage: 100 }],
    ruleSet: { __kind: 'None' },
  }] });
  const headerSize = getPluginHeaderV1AccountDataSerializer().serialize({ key: Key.PluginHeaderV1, pluginRegistryOffset: 0 }).length;
  const royaltyOffset = base.length + headerSize;
  const royaltyRecord = { pluginType: PluginType.Royalties, authority: { __kind: 'UpdateAuthority' }, offset: royaltyOffset };
  const registrySize = records => getPluginRegistryV1AccountDataSerializer().serialize({ key: Key.PluginRegistryV1, registry: records, externalRegistry: [] }).length;
  const collectionBytes = royaltyOffset + royalty.length + registrySize([royaltyRecord]);
  // CM adds UpdateDelegate with one additional PDA; authority stays UpdateAuthority.
  // Only the length matters here. The canonical instruction/account verifier
  // separately binds the actual delegate PDA to the machine.
  const delegate = getPluginSerializer().serialize({ __kind: 'UpdateDelegate', fields: [{ additionalDelegates: [plan.roles.machine] }] });
  const expandedCollectionBytes = royaltyOffset + royalty.length + delegate.length + registrySize([
    royaltyRecord, { pluginType: PluginType.UpdateDelegate, authority: { __kind: 'UpdateAuthority' }, offset: royaltyOffset + royalty.length },
  ]);
  const reserveBytes = getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1,
    owner: plan.roles.owner, updateAuthority: { __kind: 'Collection', fields: [plan.roles.collection] },
    name: reserve.name, uri: reserve.uri, seq: none() }).length;
  const machineTx = VersionedTransaction.deserialize(Buffer.from(plan.steps[2].transactionBase64, 'base64'));
  const guardInstruction = machineTx.message.compiledInstructions[2];
  const [guard, consumed] = getCreateCandyGuardInstructionDataSerializer().deserialize(guardInstruction.data);
  assert.equal(consumed, guardInstruction.data.length);
  const guardBytes = getCandyGuardSize() + guard.data.length;
  const sizes = { collection: collectionBytes, reservedAsset: reserveBytes, machine: machine.machineSpace,
    guard: guardBytes, collectionWithDelegate: expandedCollectionBytes };
  const rentItems = [
    { id: 'collection-rent', stepId: 'collection-create', bytes: sizes.collection },
    { id: 'reserve-rent', stepId: 'reserve-create', bytes: sizes.reservedAsset },
    { id: 'machine-rent', stepId: 'machine-create', bytes: sizes.machine },
    { id: 'guard-rent', stepId: 'machine-create', bytes: sizes.guard },
    { id: 'collection-delegate-growth', stepId: 'machine-create', bytes: sizes.collectionWithDelegate, subtractBytes: sizes.collection },
  ];
  return { plan, model: { revision: COST_MODEL_REVISION, sourceCommits: COST_SOURCE_COMMITS,
    scope: 'new-deployment-only', sizes, rentItems,
    protocolItems: [{ id: 'reserve-core-create-fee', stepId: 'reserve-create', lamports: CORE_CREATE_FEE_LAMPORTS }],
    steps: plan.steps.map(step => ({ id: step.id, signatures: step.requiredSigners.length })),
    requiredSignatures: plan.steps.reduce((sum, step) => sum + step.requiredSigners.length, 0),
    // Fixed-policy deployment has no public mint/payment, tip or compute-budget instruction.
    priorityFeeLamports: '0', buyerMintsIncluded: 0, salesOpen: false,
    assumptions: ['deployed-programs-match-reviewed-layouts-and-fees'],
    excluded: ['future-buyer-mints', 'reveal-transactions', 'hosting-storage-domain-and-RPC-subscriptions', 'SOL-exchange-rate'],
  } };
}
