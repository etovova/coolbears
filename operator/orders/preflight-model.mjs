// Read-only first-item preflight for a fresh order in the closed Devnet profile.
// No signer custody, wallet invocation, journal mutation or submission grant.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { baseAssetBytes, verifySimulatedMintCost, CORE_CREATE_LAMPORTS } from './mint-cost.mjs';
import { validateBlockhashAnchor } from './blockhash-anchor.mjs';
import { validateAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from './signing.mjs';
import { createDeploymentRpc, assertCluster, DeploymentRpcError } from '../deployment/rpc.mjs';

export function createOrderChecker(policy, { validateOrder, buildOrderTransactions, verifyOrderAccounts }) {
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

function preflightOrder(options) { return checkOrder(options); }
// Internal trusted adapter for a sign-only closed Devnet session, not a purchase grant.
function checkPreparedOrder(options) { return checkOrder(options, true); }
function checkSignedOrder(options) { return checkOrder(options, true, true); }
async function checkOrder({ readOrder, endpoint, fetchImpl, timeoutMs, claim, request, response, blockhashAnchor } = {}, prepared = false, signedMode = false) {
  let rpc, phase = 'order';
  const started = performance.now();
  try {
    need(typeof readOrder === 'function', 'ORDER_READER_REQUIRED');
    const order = structuredClone(validateOrder(await readOrder())), orderSha256 = hash(order);
    need(order.cluster === 'devnet', 'DEVNET_ONLY');
    if (prepared) {
      claim = structuredClone(claim); request = structuredClone(request);
      validateAssetRequest(order, claim, request);
      blockhashAnchor = validateBlockhashAnchor(structuredClone(blockhashAnchor), claim);
      need(!order.paused && order.items[0].attempts.length === claim.attempt && order.items.slice(1).every(item => !item.attempts.length), 'PREPARED_ORDER_REQUIRED');
      if (signedMode) {
        response = verifyBuyerSigningResponse(order, claim, request, structuredClone(response));
        need(order.revision >= claim.orderRevision+2 && order.items[0].attempts.at(-1).state === 'unknown'
          && order.items[0].attempts.at(-1).signature === response.signature, 'SAVED_RESPONSE_REQUIRED');
      } else need(order.revision === claim.orderRevision && order.items[0].attempts.at(-1).state === 'wallet-pending', 'PREPARED_ORDER_REQUIRED');
    } else need(order.revision === 0 && !order.paused && order.items.every(item => item.attempts.length === 0), 'FRESH_ORDER_REQUIRED');
    need([order.buyer, ...order.items.map(item => item.asset)].every(address => PublicKey.isOnCurve(new PublicKey(address).toBytes())), 'UNSIGNABLE_ADDRESS');
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000, allowSimulation: true });
    phase = 'network'; await assertCluster(rpc, 'devnet');
    phase = 'accounts'; const initial = await readState(rpc, order);
    phase = 'balance';
    const balance = await rpc.call('getBalance', [order.buyer, { commitment: 'confirmed', minContextSlot: initial.slot }]);
    let slot = context(balance, initial.slot);
    if (prepared) slot = Math.max(slot, blockhashAnchor.sourceSlot);
    const funds = amount(balance.value);
    phase = 'blockhash';
    let template;
    if (prepared) template = request;
    else {
      const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: slot }]);
      slot = context(latest, slot);
      const planned = buildOrderTransactions(order, latest.value); template = planned.templates[0];
      need(template?.itemIndex === 0 && planned.templates.length === order.quantity, 'ORDER_TEMPLATE');
    }
    const encoded = signedMode ? response.transactionBase64 : prepared ? request.transactionBase64 : Buffer.from(template.unsignedBytes).toString('base64');
    const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
    phase = 'cost';
    const feeResult = await rpc.call('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'),
      { commitment: 'confirmed', minContextSlot: slot }]);
    slot = context(feeResult, slot); const fee = amount(feeResult.value); need(fee > 0n, 'FEE_UNAVAILABLE');
    const assetBytes = baseAssetBytes(policy, order).length;
    const rent = amount(await rpc.call('getMinimumBalanceForRentExemption', [assetBytes, { commitment: 'confirmed' }]));
    need(rent > 0n, 'RENT_UNAVAILABLE');
    const knownMinimum = BigInt(order.unitPriceLamports) + fee + rent + CORE_CREATE_LAMPORTS;
    need(funds >= knownMinimum, 'INSUFFICIENT_BALANCE');
    phase = 'simulation';
    const simulation = await rpc.call('simulateTransaction', [encoded, { encoding: 'base64', commitment: 'confirmed',
      minContextSlot: slot, sigVerify: signedMode, replaceRecentBlockhash: false,
      accounts: { encoding: 'base64', addresses: [template.asset] } }]);
    slot = context(simulation, slot);
    need(simulation.value?.err === null && simulation.value.replacementBlockhash == null
      && Number.isSafeInteger(simulation.value.unitsConsumed) && simulation.value.unitsConsumed >= 0
      && simulation.value.unitsConsumed <= 300000, 'SIMULATION_FAILED');
    verifySimulatedMintCost(policy, order, simulation.value.accounts, rent);
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
    const checkedAt = Date.now();
    return { status: signedMode ? 'submission-check-passed' : prepared ? 'wallet-check-passed' : 'preflight-passed',
      mode: signedMode ? 'closed-devnet-send-check' : prepared ? 'closed-devnet-sign-only-check' : 'closed-devnet-order-preview',
      ...(prepared ? { requestId: buyerRequestId(request), checkedAt, expiresAt: checkedAt + 20000 } : {}), orderId: order.id,
      orderRevision: order.revision, orderSha256, itemIndex: 0, quantity: order.quantity,
      itemsRemaining: final.itemsRemaining, checkedSlot: slot, accountSlot: final.slot,
      cluster: 'devnet', networkVerified: true, guardPriceVerified: true, blockhashVerified: true, blockhashProvenanceVerified: true,
      simulationVerified: true, simulationMode: signedMode ? 'signed' : 'unsigned', remainingBlocks: template.lastValidBlockHeight - height,
      candidate: { asset: template.asset, transactionBase64: encoded, messageSha256: template.messageSha256,
        blockhash: template.blockhash, lastValidBlockHeight: template.lastValidBlockHeight },
      budget: { complete: true, scope: 'next-item-current-template', unitPriceLamports: order.unitPriceLamports, orderItemPriceLamports: order.totalPriceLamports,
        nextItemFeeLamports: fee.toString(), nextItemBaseRentLamports: rent.toString(), baseAssetBytes: assetBytes,
        nextItemKnownMinimumLamports: knownMinimum.toString(), protocolChargesLamports: CORE_CREATE_LAMPORTS.toString(), priorityFeeLamports: '0',
        projectedOrderTotalLamports: (knownMinimum * BigInt(order.quantity)).toString(), projectionOnly: true,
        fullOrderTotalLamports: null, balanceLamports: String(latestBalance.value) },
      networkRequests: rpc.requests, signaturesCreated: 0, journalWrites: 0, transactionsSent: 0,
      readyToSign: prepared && !signedMode, readyToSubmit: false, salesOpen: false };
  } catch (error) {
    const code = error instanceof DeploymentRpcError ? `RPC_${error.code}`
      : error?.code === 'EXPECTED_ACCOUNT_STATE_MISMATCH' ? 'ACCOUNT_STATE_MISMATCH'
        : error?.checkCode ?? 'ORDER_PREFLIGHT_FAILED';
    return { status: 'blocked', phase, code, networkRequests: rpc?.requests ?? 0,
      signaturesCreated: 0, journalWrites: 0, transactionsSent: 0,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  }
}

return { preflightOrder, checkPreparedOrder, checkSignedOrder };
}
