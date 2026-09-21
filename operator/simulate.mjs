// Read-only RPC simulation. No wallet request and no sendTransaction call.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { createCollection, create, mplCore } from '@metaplex-foundation/mpl-core';
import { create as createMachine, addConfigLines, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import jsonGuardParser from './node_modules/@metaplex-foundation/cli/dist/lib/cm/jsonGuardParser.js';
import { getConfigLineSettings } from './node_modules/@metaplex-foundation/cli/dist/lib/cm/cm-utils.js';
import { makePreparation, policy } from './prepare.mjs';
import { validateEndpoint, DEVNET } from './preflight.mjs';

export async function simulatePreparation(endpoint) {
  validateEndpoint(endpoint);
  const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const umi = createUmi(endpoint, { commitment: 'confirmed', fetch: boundedFetch, disableRetryOnRateLimit: true })
    .use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(publicKey(policy.owner))));
  assert.equal(await umi.rpc.getGenesisHash(), DEVNET, 'Devnet required');
  const output = { checkedAt: new Date().toISOString(), cluster: 'devnet', mode: 'unsigned-rpc-simulation', ownerSignature: false, transactionsSent: 0, collectionAndAsset: null, smallMachineCreation: null };
  for (const scenario of ['collectionAndAsset', 'smallMachineCreation']) {
    const collection = generateSigner(umi);
    const preparation = makePreparation({ collection: collection.publicKey });
    let builder = setComputeUnitLimit(umi, { units: 800000 }).add(createCollection(umi, {
      collection, name: policy.collectionName, uri: `${policy.website}/metadata/collection.json`, plugins: Object.values(preparation.plugins),
    }));
    if (scenario === 'collectionAndAsset') {
      builder = builder.add(create(umi, {
        asset: generateSigner(umi), collection: collection.publicKey,
        owner: publicKey(policy.owner), name: preparation.documents[0].name,
        uri: `${policy.website}/metadata/0000.json`,
      }));
    } else {
      // A two-item setup probes the same programs and CLI guard/config parser.
      // It does NOT claim to mint, fund or execute a 9,999-item production machine.
      const machine = generateSigner(umi);
      const config = preparation.cmConfig;
      config.config.itemsAvailable = 2;
      const guards = jsonGuardParser(config);
      builder = builder.add(await createMachine(umi, {
        ...config.config, candyMachine: machine, collection: collection.publicKey,
        collectionUpdateAuthority: umi.identity, guards: guards.guards, groups: guards.groups,
        ...getConfigLineSettings(config),
      }));
      const withItems = builder.add(addConfigLines(umi, {
        candyMachine: machine.publicKey, index: 0,
        configLines: Object.values(preparation.assetCache.assetItems).slice(0, 2).map(item => ({ name: item.name, uri: item.jsonUri })),
      }));
      // The setup and insertion are distinct official CLI operations in production.
      if (withItems.fitsInOneTransaction(umi)) builder = withItems;
    }
    const size = builder.getTransactionSize(umi);
    assert.ok(builder.fitsInOneTransaction(umi), `Simulation exceeds transaction size: ${size}`);
    const tx = await builder.setBlockhash(await umi.rpc.getLatestBlockhash()).buildAndSign(umi);
    const result = await umi.rpc.simulateTransaction(tx, { verifySignatures: false, commitment: 'confirmed' });
    output[scenario] = { transactionBytes: size, err: result.err, unitsConsumed: result.unitsConsumed, logs: result.logs };
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await simulatePreparation(process.env.COOLBEARS_RPC_URL);
    console.log(JSON.stringify(result, null, 2));
    if (result.collectionAndAsset?.err || result.smallMachineCreation?.err) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ status: 'simulation-blocked', message: String(error.message).replaceAll(process.env.COOLBEARS_RPC_URL || '[unset]', '[RPC]'), transactionsSent: 0 }));
    process.exitCode = 1;
  }
}
