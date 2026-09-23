// Read-only first-item preflight for a fresh order in the closed Devnet profile.
// No signer custody, wallet invocation, journal mutation or submission grant.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { none } from '@metaplex-foundation/umi';
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { policy } from '../prepare.mjs';
import { validateOrder } from './journal.mjs';
import { buildOrderTransactions } from './transactions.mjs';
import { verifyOrderAccounts } from '../deployment/accounts.mjs';
import { createDeploymentRpc, assertCluster, DeploymentRpcError } from '../deployment/rpc.mjs';

const PROGRAMS = [MPL_CORE_PROGRAM_ID, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID];
const need = (ok, checkCode) => { if (!ok) throw Object.assign(Error(checkCode), { checkCode }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function context(value, minimum) {
  need(Number.isSafeInteger(value?.context?.slot) && value.context.slot >= minimum && Object.hasOwn(value, 'value'), 'RPC_CONTEXT');
  return value.context.slot;
}
function amount(value) { need(Number.isSafeInteger(value) && value >= 0, 'RPC_AMOUNT'); return BigInt(value); }
async function readState(rpc, order, minimum = 0) {
  const addresses = [...PROGRAMS, order.machine, order.guard, order.collection, ...order.items.map(item => item.asset)];
  const result = await rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized', minContextSlot: minimum }]);
  const slot = context(result, minimum);
  need(Array.isArray(result.value) && result.value.length === addresses.length, 'ACCOUNT_LIST');
  need(result.value.slice(0, 3).every(value => value?.executable === true), 'PROGRAM_UNAVAILABLE');
  const state = verifyOrderAccounts(order, result.value.slice(3, 6));
  need(result.value.slice(6).every(value => value === null), 'ASSET_ALREADY_EXISTS');
  need(state.itemsRemaining >= order.quantity, 'INSUFFICIENT_SUPPLY');
  need(state.buyerAllowed, 'SALES_CLOSED');
  return { ...state, slot };
}

export async function preflightOrder({ readOrder, endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, phase = 'order';
  const started = performance.now();
  try {
    need(typeof readOrder === 'function', 'ORDER_READER_REQUIRED');
    const order = structuredClone(validateOrder(await readOrder())), orderSha256 = hash(order);
    need(order.cluster === 'devnet', 'DEVNET_ONLY');
    need(order.revision === 0 && !order.paused && order.items.every(item => item.attempts.length === 0), 'FRESH_ORDER_REQUIRED');
    need([order.buyer, ...order.items.map(item => item.asset)].every(address => PublicKey.isOnCurve(new PublicKey(address).toBytes())), 'UNSIGNABLE_ADDRESS');
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000, allowSimulation: true });
    phase = 'network'; await assertCluster(rpc, 'devnet');
    phase = 'accounts'; const initial = await readState(rpc, order);
    phase = 'balance';
    const balance = await rpc.call('getBalance', [order.buyer, { commitment: 'confirmed', minContextSlot: initial.slot }]);
    let slot = context(balance, initial.slot); const funds = amount(balance.value);
    phase = 'blockhash';
    const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: slot }]);
    slot = context(latest, slot);
    const planned = buildOrderTransactions(order, latest.value), template = planned.templates[0];
    need(template?.itemIndex === 0 && planned.templates.length === order.quantity, 'ORDER_TEMPLATE');
    const encoded = Buffer.from(template.unsignedBytes).toString('base64');
    const tx = VersionedTransaction.deserialize(template.unsignedBytes);
    phase = 'cost';
    const feeResult = await rpc.call('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'),
      { commitment: 'confirmed', minContextSlot: slot }]);
    slot = context(feeResult, slot); const fee = amount(feeResult.value); need(fee > 0n, 'FEE_UNAVAILABLE');
    // Every approved hidden name/URI has the same byte length. This is base
    // asset rent only; no claim that protocol charges or a full order are quoted.
    const assetBytes = getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1, owner: order.buyer,
      updateAuthority: { __kind: 'Collection', fields: [order.collection] }, seq: none(),
      name: policy.hiddenName.replace('{index:04d}', '0001'), uri: `${policy.website}/metadata/hidden/0001.json` }).length;
    const rent = amount(await rpc.call('getMinimumBalanceForRentExemption', [assetBytes, { commitment: 'confirmed' }]));
    need(rent > 0n, 'RENT_UNAVAILABLE');
    const knownMinimum = BigInt(order.unitPriceLamports) + fee + rent;
    need(funds >= knownMinimum, 'INSUFFICIENT_BALANCE');
    phase = 'simulation';
    const simulation = await rpc.call('simulateTransaction', [encoded, { encoding: 'base64', commitment: 'confirmed',
      minContextSlot: slot, sigVerify: false, replaceRecentBlockhash: false }]);
    slot = context(simulation, slot);
    need(simulation.value?.err === null && simulation.value.replacementBlockhash == null
      && Number.isSafeInteger(simulation.value.unitsConsumed) && simulation.value.unitsConsumed >= 0
      && simulation.value.unitsConsumed <= 300000, 'SIMULATION_FAILED');
    phase = 'freshness';
    // Finalized accounts need not overtake a confirmed simulation bank.
    const final = await readState(rpc, order, initial.slot);
    need(final.itemsRemaining <= initial.itemsRemaining, 'INVENTORY_ROLLBACK');
    const latestBalance = await rpc.call('getBalance', [order.buyer, { commitment: 'confirmed', minContextSlot: Math.max(slot, final.slot) }]);
    slot = context(latestBalance, Math.max(slot, final.slot));
    need(amount(latestBalance.value) >= knownMinimum, 'INSUFFICIENT_BALANCE');
    const valid = await rpc.call('isBlockhashValid', [template.blockhash, { commitment: 'confirmed', minContextSlot: slot }]);
    slot = context(valid, slot); need(valid.value === true, 'BLOCKHASH_EXPIRED');
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: slot }]);
    need(Number.isSafeInteger(height) && height >= 0 && template.lastValidBlockHeight - height >= 80, 'BLOCKHASH_TOO_OLD');
    phase = 'order-recheck';
    need(hash(validateOrder(await readOrder())) === orderSha256, 'ORDER_CHANGED');
    need(performance.now() - started <= 30000, 'PREFLIGHT_TOO_OLD');
    return { status: 'preflight-passed', mode: 'closed-devnet-order-preview', orderId: order.id,
      orderRevision: order.revision, orderSha256, itemIndex: 0, quantity: order.quantity,
      itemsRemaining: final.itemsRemaining, checkedSlot: slot, accountSlot: final.slot,
      cluster: 'devnet', networkVerified: true, guardPriceVerified: true, blockhashVerified: true,
      simulationVerified: true, simulationMode: 'unsigned', remainingBlocks: template.lastValidBlockHeight - height,
      candidate: { asset: template.asset, transactionBase64: encoded, messageSha256: template.messageSha256,
        blockhash: template.blockhash, lastValidBlockHeight: template.lastValidBlockHeight },
      budget: { complete: false, unitPriceLamports: order.unitPriceLamports, orderItemPriceLamports: order.totalPriceLamports,
        nextItemFeeLamports: fee.toString(), nextItemBaseRentLamports: rent.toString(), baseAssetBytes: assetBytes,
        nextItemKnownMinimumLamports: knownMinimum.toString(), protocolChargesLamports: null,
        fullOrderTotalLamports: null, balanceLamports: String(latestBalance.value) },
      networkRequests: rpc.requests, signaturesCreated: 0, journalWrites: 0, transactionsSent: 0,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  } catch (error) {
    const code = error instanceof DeploymentRpcError ? `RPC_${error.code}`
      : error?.code === 'EXPECTED_ACCOUNT_STATE_MISMATCH' ? 'ACCOUNT_STATE_MISMATCH'
        : error?.checkCode ?? 'ORDER_PREFLIGHT_FAILED';
    return { status: 'blocked', phase, code, networkRequests: rpc?.requests ?? 0,
      signaturesCreated: 0, journalWrites: 0, transactionsSent: 0,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  }
}
