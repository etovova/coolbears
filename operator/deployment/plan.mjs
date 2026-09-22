// Offline deployment templates built with the installed official Core SDK and
// CLI guard parser. No key generation, signing, RPC or broadcast is available.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, publicKey, signerIdentity, lamports } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createCollection, create as createAsset, mplCore } from '@metaplex-foundation/mpl-core';
import { create as createMachine, addConfigLines, findCandyGuardPda, getCandyMachineSize, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import jsonGuardParser from '../node_modules/@metaplex-foundation/cli/dist/lib/cm/jsonGuardParser.js';
import { makePreparation, policy } from '../prepare.mjs';

const MAX_BYTES = 1232;
const U64_MAX = (1n << 64n) - 1n;
const offlineOnly = () => { throw Error('DEPLOYMENT_OFFLINE_ONLY'); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function checkedAddress(value) {
  assert.equal(typeof value, 'string', 'INVALID_PUBLIC_ADDRESS');
  const address = publicKey(value);
  assert.equal(base58.serialize(address).length, 32, 'INVALID_PUBLIC_ADDRESS');
  return address;
}

function placeholder(value) {
  return Object.freeze({ ...createNoopSigner(checkedAddress(value)),
    signMessage: offlineOnly, signTransaction: offlineOnly, signAllTransactions: offlineOnly });
}

function offlineContext(owner, rent, expectedSpace) {
  const umi = createUmi('http://127.0.0.1:1', { fetch: offlineOnly })
    .use(mplCore()).use(mplCandyMachine()).use(signerIdentity(owner));
  const programs = umi.programs;
  umi.programs = { ...programs,
    get: identifier => programs.get(identifier, '*'),
    getPublicKey: (identifier, fallback) => programs.getPublicKey(identifier, fallback, '*'),
    has: identifier => programs.has(identifier, '*'), all: () => programs.all('*') };
  // createMachine requests rent when constructing its createAccount instruction.
  // This supplies an explicit offline quote input, not a network read.
  umi.rpc = new Proxy({}, { get(_target, property) {
    if (property === 'getRent') return async space => {
      assert.equal(space, expectedSpace, 'UNEXPECTED_RENT_ACCOUNT_SIZE');
      return lamports(rent);
    };
    return offlineOnly;
  } });
  umi.http = new Proxy({}, { get: () => offlineOnly });
  umi.eddsa = new Proxy(umi.eddsa, { get(target, property) {
    if (['generateKeypair', 'createKeypairFromSecretKey', 'createKeypairFromSeed', 'sign'].includes(property)) return offlineOnly;
    return Reflect.get(target, property);
  } });
  return umi;
}

export async function buildDeploymentPlan({ cluster, collection, reservedAsset, machine,
  blockhash, lastValidBlockHeight, machineRentLamports } = {}) {
  assert.ok(['devnet', 'mainnet-beta'].includes(cluster), 'INVALID_CLUSTER');
  for (const value of [collection, reservedAsset, machine, blockhash]) checkedAddress(value);
  assert.equal(new Set([collection, reservedAsset, machine, policy.owner]).size, 4, 'DUPLICATE_DEPLOYMENT_ADDRESS');
  assert.ok(Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0, 'INVALID_BLOCK_HEIGHT');
  assert.ok(typeof machineRentLamports === 'string' && /^[1-9][0-9]*$/.test(machineRentLamports), 'INVALID_MACHINE_RENT');
  const rent = BigInt(machineRentLamports);
  assert.ok(rent <= U64_MAX, 'INVALID_MACHINE_RENT');
  const preparation = makePreparation({ collection });
  const config = preparation.cmConfig.config;
  const machineSpace = getCandyMachineSize(config.itemsAvailable, config.configLineSettings);
  const owner = placeholder(policy.owner);
  const umi = offlineContext(owner, rent, machineSpace);
  const collectionSigner = placeholder(collection), assetSigner = placeholder(reservedAsset), machineSigner = placeholder(machine);
  const guard = findCandyGuardPda(umi, { base: machineSigner.publicKey })[0];
  assert.ok(![collection, reservedAsset, machine, policy.owner].includes(guard), 'DUPLICATE_DEPLOYMENT_ADDRESS');
  const roles = { owner: policy.owner, payer: policy.owner, collection, reservedAsset, machine, guard,
    collectionUpdateAuthority: policy.owner, candyMachineAuthority: policy.owner, candyGuardAuthority: policy.owner };
  const steps = [];
  const block = { blockhash, lastValidBlockHeight };
  const configured = builder => builder.useV0().setFeePayer(owner).setBlockhash(block);
  function append(id, kind, builder, expected) {
    const built = configured(builder), transaction = built.build(umi);
    const bytes = umi.transactions.serialize(transaction);
    assert.ok(bytes.length <= MAX_BYTES, 'DEPLOYMENT_TRANSACTION_TOO_LARGE');
    assert.ok(Object.values(transaction.signatures).every(signature => signature.every(byte => byte === 0)), 'UNEXPECTED_SIGNATURE');
    const requiredSigners = built.getSigners(umi).map(signer => signer.publicKey);
    assert.equal(requiredSigners[0], policy.owner, 'UNEXPECTED_FEE_PAYER');
    assert.ok(requiredSigners.every(address => [policy.owner, collection, reservedAsset, machine].includes(address)), 'UNEXPECTED_SIGNER');
    steps.push({ id, kind, dependsOn: steps.length ? [steps.at(-1).id] : [], requiredSigners,
      transactionBase64: Buffer.from(bytes).toString('base64'), serializedSize: bytes.length,
      messageSha256: sha256(transaction.serializedMessage), ...block, expected });
  }

  append('collection-create', 'collection-create', createCollection(umi, {
    collection: collectionSigner, payer: owner, updateAuthority: owner.publicKey,
    name: policy.collectionName, uri: `${policy.website}/metadata/collection.json`,
    plugins: Object.values(preparation.plugins),
  }), { collection, updateAuthority: policy.owner, name: policy.collectionName,
    uri: `${policy.website}/metadata/collection.json`, royaltyBasisPoints: policy.royaltyPercent * 100, royaltyRecipient: policy.owner });

  append('reserve-create', 'reserve-create', createAsset(umi, {
    asset: assetSigner, collection: { publicKey: collectionSigner.publicKey },
    authority: owner, payer: owner, owner: owner.publicKey,
    name: preparation.documents[0].name, uri: preparation.releasePlan.reservedAsset.uri,
  }), { asset: reservedAsset, index: 0, collection, owner: policy.owner,
    name: preparation.documents[0].name, uri: preparation.releasePlan.reservedAsset.uri });

  const parsed = jsonGuardParser(preparation.cmConfig);
  const machineBuilder = await createMachine(umi, {
    ...config, candyMachine: machineSigner, collection: collectionSigner.publicKey,
    payer: owner, authority: owner.publicKey, collectionUpdateAuthority: owner,
    guards: parsed.guards, groups: parsed.groups,
  });
  const machineExpected = { machine, guard, collection, authority: policy.owner,
    guardAuthority: policy.owner, mintAuthority: guard, itemsAvailable: config.itemsAvailable,
    itemsLoaded: 0, machineSpace, machineRentLamports, configLineSettings: config.configLineSettings,
    addressGate: policy.owner, payment: preparation.releasePlan.payment, salesOpen: false };
  // The complete fixed-policy bundle fits as one transaction. Do not invent
  // partially initialized deployment states if a future SDK/policy exceeds it.
  assert.equal(machineBuilder.items.length, 4, 'UNEXPECTED_MACHINE_INSTRUCTION_LAYOUT');
  append('machine-create', 'machine-create', machineBuilder, machineExpected);

  // Match the installed CLI's conservative contiguous grouping, then pack by
  // actual SDK transaction size. All names/URIs come from the canonical package.
  const items = Object.values(preparation.assetCache.assetItems);
  const maxNameLength = Math.max(...items.map(item => item.name.length));
  const maxUriLength = Math.max(...items.map(item => item.jsonUri.length));
  const groupSize = Math.max(1, Math.floor((MAX_BYTES - 200) / (maxUriLength + maxNameLength + 50)));
  let pending = null, pendingLines = [], pendingIndex = 0, batch = 0;
  function flush() {
    if (!pending) return;
    append(`insert-${String(batch++).padStart(4, '0')}`, 'insert', pending,
      { machine, authority: policy.owner, startingIndex: pendingIndex,
        count: pendingLines.length, configLines: pendingLines });
    pending = null; pendingLines = [];
  }
  for (let index = 0; index < items.length; index += groupSize) {
    const configLines = items.slice(index, index + groupSize).map(item => ({ name: item.name, uri: item.jsonUri }));
    const instruction = addConfigLines(umi, { candyMachine: machineSigner.publicKey,
      authority: owner, index, configLines });
    assert.ok(configured(instruction).getTransactionSize(umi) <= MAX_BYTES, 'CONFIG_LINE_GROUP_TOO_LARGE');
    const merged = pending ? pending.add(instruction) : instruction;
    if (configured(merged).getTransactionSize(umi) > MAX_BYTES) flush();
    if (!pending) { pending = instruction; pendingIndex = index; }
    else pending = pending.add(instruction);
    pendingLines.push(...configLines);
  }
  flush();
  return { version: 1, mode: 'offline-unsigned-deployment', cluster, roles,
    supply: policy.supply, machineItems: items.length, reservedItems: 1,
    readyToSubmit: false, networkVerified: false, blockhashVerified: false,
    rentVerified: false, feeQuote: null, machineRentLamports, machineSpace,
    networkRequests: 0, signaturesCreated: 0, transactionsSent: 0, salesOpen: false, steps };
}

// This projection carries intent, not proof that addresses, rent or authorities
// exist on chain. Journal validation independently checks bytes and bindings.
export function deploymentManifestFromPlan(id, plan) {
  assert.ok(typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id), 'INVALID_DEPLOYMENT_ID');
  assert.equal(plan?.mode, 'offline-unsigned-deployment', 'INVALID_DEPLOYMENT_PLAN');
  return structuredClone({ version: 1, id, cluster: plan.cluster, owner: plan.roles.owner,
    steps: plan.steps.map(({ id, dependsOn, transactionBase64, messageSha256, blockhash,
      lastValidBlockHeight, requiredSigners, expected }) => ({ id, dependsOn, transactionBase64,
      messageSha256, blockhash, lastValidBlockHeight, requiredSigners, expected })) });
}
