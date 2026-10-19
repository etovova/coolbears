// Integer-only scenario arithmetic. Unknown bills never become zero costs.
import assert from 'node:assert/strict';
import { formatSol } from '../deployment/budget.mjs';

function amount(value) {
  assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'Expected unsigned integer lamports');
  const result = BigInt(value);
  assert.ok(result <= 18446744073709551615n, 'Amount exceeds u64');
  return result;
}
function count(value, maximum) {
  assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= maximum, 'Invalid quantity');
  return BigInt(value);
}
const money = n => ({ lamports: n.toString(), sol: formatSol(n) });

export function priorityFeeLamports(computeUnits, microLamportsPerCu) {
  const units = count(computeUnits, 1400000);
  return ((units * amount(microLamportsPerCu) + 999999n) / 1000000n).toString();
}

export function buyerCost({ quantity, priceLamports, rentLamports, protocolLamports,
  baseFeeLamports, priorityLamports = '0' }) {
  const n = count(quantity, 50);
  const price = amount(priceLamports), rent = amount(rentLamports), protocol = amount(protocolLamports);
  const base = amount(baseFeeLamports), priority = amount(priorityLamports);
  return { quantity, transactions: quantity, requiredSignaturesPerTransaction: 2,
    price: money(price * n), accountRent: money(rent * n), protocolCharge: money(protocol * n),
    baseNetworkFees: money(base * n), priorityFees: money(priority * n),
    overhead: money((rent + protocol + base + priority) * n),
    total: money((price + rent + protocol + base + priority) * n),
    payer: 'buyer', projection: true, publicMintCurrentlyAllowed: false };
}

export function revealCost({ quantity, oldRentLamports, newRentLamports, baseFeeLamports, priorityLamports = '0' }) {
  const n = count(quantity, 10000), delta = amount(newRentLamports) - amount(oldRentLamports);
  const fees = (amount(baseFeeLamports) + amount(priorityLamports)) * n;
  const topup = (delta > 0n ? delta : 0n) * n, refund = (delta < 0n ? -delta : 0n) * n;
  return { quantity, transactions: quantity, requiredSignaturesPerTransaction: 1,
    rentTopup: money(topup), possibleRentRefund: money(refund), networkFees: money(fees),
    // Do not treat future refunds or sale proceeds as available upfront funds.
    grossFundingBeforeRefunds: money(topup + fees), refundUsedToReduceFunding: false,
    payer: 'collection-update-authority', projection: true, actualRevealExecuted: false };
}

export function ownerChainScenario(preparationLamports, reveal) {
  return { preparation: money(amount(preparationLamports)), reveal: reveal.grossFundingBeforeRefunds,
    grossChainSubtotal: money(amount(preparationLamports) + amount(reveal.grossFundingBeforeRefunds.lamports)),
    includesBuyerCosts: false, includesServices: false, includesContingency: false,
    includesPriorityFees: false, includesFailedAttempts: false,
    budgetComplete: false, fundingRecommendationLamports: null };
}
