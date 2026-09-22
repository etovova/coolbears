// Offline instruction planning only. No RPC, private keys, wallet requests,
// signing, simulation, sending or journal mutation is available in this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { itemsToPlan } from './journal.mjs';

const COMPUTE_UNITS = 300000;
const MAX_TRANSACTION_BYTES = 1232;
const offlineOnly = () => { throw Error('Offline order planner: RPC and signing are disabled'); };

function placeholderSigner(address) {
  // Preserve the SDK's signer shape, but make any accidental signing call fail.
  return Object.freeze({
    ...createNoopSigner(publicKey(address)),
    signMessage: offlineOnly, signTransaction: offlineOnly, signAllTransactions: offlineOnly,
  });
}

function offlineContext(buyer) {
  // Constructing the SDK does not connect. Both its fetch transport and every
  // RPC property are blocked before an instruction or transaction is built.
  const umi = createUmi('http://127.0.0.1:1', { fetch: offlineOnly })
    .use(mplCore()).use(mplCandyMachine()).use(signerIdentity(buyer));
  const programs = umi.programs;
  // Core program identities are local, cluster-independent constants. Resolve
  // them without the repository's usual rpc.getCluster() metadata accessor.
  umi.programs = {
    ...programs,
    get: identifier => programs.get(identifier, '*'),
    getPublicKey: (identifier, fallback) => programs.getPublicKey(identifier, fallback, '*'),
    has: identifier => programs.has(identifier, '*'),
    all: () => programs.all('*'),
  };
  umi.rpc = new Proxy({}, { get: offlineOnly });
  umi.http = new Proxy({}, { get: offlineOnly });
  // PDA calculation is public-key arithmetic. Key generation and signing are
  // intentionally unavailable, including methods not used by today's builder.
  umi.eddsa = new Proxy(umi.eddsa, {
    get(target, property) {
      if (['generateKeypair', 'createKeypairFromSecretKey', 'createKeypairFromSeed', 'sign'].includes(property)) return offlineOnly;
      return Reflect.get(target, property);
    },
  });
  return umi;
}

function checkBlockhash(blockhash, lastValidBlockHeight) {
  let valid = false;
  try { valid = typeof blockhash === 'string' && base58.serialize(blockhash).length === 32; } catch { /* Use a fixed diagnostic. */ }
  assert.ok(valid, 'Supply a valid public blockhash for offline planning');
  assert.ok(Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0, 'Supply a positive lastValidBlockHeight');
}

export function buildOrderTransactions(order, { blockhash, lastValidBlockHeight, retry = false } = {}) {
  assert.ok(typeof retry === 'boolean', 'Retry planning must be explicitly boolean');
  // This validates the complete journal and rejects unresolved/paused orders.
  // Completed entries and retries without explicit consent are not re-planned.
  const items = itemsToPlan(order, { retry });
  checkBlockhash(blockhash, lastValidBlockHeight);
  const buyer = placeholderSigner(order.buyer);
  const umi = offlineContext(buyer);
  const templates = items.map(item => {
    const asset = placeholderSigner(item.asset);
    const builder = setComputeUnitLimit(umi, { units: COMPUTE_UNITS }).add(mintV1(umi, {
      candyMachine: publicKey(order.machine), candyGuard: publicKey(order.guard),
      collection: publicKey(order.collection),
      payer: buyer, minter: buyer, owner: buyer.publicKey, asset,
      mintArgs: { solPayment: { destination: publicKey(order.treasury) } },
    })).useV0().setFeePayer(buyer).setBlockhash({ blockhash, lastValidBlockHeight });
    const transaction = builder.build(umi);
    const unsignedBytes = umi.transactions.serialize(transaction);
    assert.ok(unsignedBytes.length <= MAX_TRANSACTION_BYTES, 'One-asset mint exceeds the transaction size limit');
    const requiredSigners = builder.getSigners(umi).map(signer => signer.publicKey);
    assert.deepEqual(requiredSigners, [order.buyer, item.asset], 'Unexpected signer roles in offline transaction');
    assert.ok(Object.values(transaction.signatures).every(signature => !signature.some(Boolean)), 'Offline template contains an unexpected signature');
    return Object.freeze({
      itemIndex: item.index, asset: item.asset, version: 0,
      unsignedBytes: new Uint8Array(unsignedBytes), serializedSize: unsignedBytes.length,
      messageSha256: createHash('sha256').update(transaction.serializedMessage).digest('hex'),
      blockhash, lastValidBlockHeight,
      requiredSigners: Object.freeze(requiredSigners), feePayer: order.buyer, owner: order.buyer,
      payment: Object.freeze({ destination: order.treasury, lamports: order.unitPriceLamports }),
    });
  });
  return Object.freeze({
    mode: 'offline-unsigned-order', orderId: order.id, orderRevision: order.revision, cluster: order.cluster,
    quantity: order.quantity, plannedTransactions: templates.length,
    unitPriceLamports: order.unitPriceLamports,
    totalPriceLamports: (BigInt(order.unitPriceLamports) * BigInt(templates.length)).toString(),
    // The SOL amount lives in Candy Guard state, not the mint instruction's
    // bytes. This is the policy expectation, not proof of a current on-chain
    // guard price, balance, fee, remaining supply or usable blockhash.
    guardPriceVerified: false, blockhashVerified: false, networkVerified: false, feeQuote: null,
    networkRequests: 0, signaturesCreated: 0, transactionsSent: 0,
    templates: Object.freeze(templates),
  });
}
