// Offline, single-writer order model. No wallet, RPC, signing or dispatch code.
// Normalized evidence is input from a future trusted read-only adapter; this
// module does not authenticate it or prove anything on chain by itself.
import { publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
export function createOrderModel(policy) {

const PRICE = String(policy.priceSol * 1e9);
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const ACTIVE = new Set(['wallet-pending', 'signed', 'sending', 'submitted', 'unknown']);
const RETRYABLE = new Set(['cancelled', 'failed', 'expired']);
const STATES = new Set([...ACTIVE, ...RETRYABLE, 'verified']);
const ALLOWED_NEXT = {
  'wallet-pending': ['signed', 'unknown', 'cancelled', 'verified', 'failed', 'expired'],
  signed: ['sending', 'unknown', 'verified', 'failed', 'expired'],
  sending: ['submitted', 'unknown', 'verified', 'failed', 'expired'],
  submitted: ['unknown', 'verified', 'failed', 'expired'],
  unknown: ['unknown', 'verified', 'failed', 'expired'],
};
const last = item => item.attempts.at(-1);
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function address(value) {
  requireThat(typeof value === 'string', 'INVALID_ADDRESS');
  try { publicKey(value); } catch { throw Error('INVALID_ADDRESS'); }
}
function signature(value) {
  requireThat(typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value), 'INVALID_SIGNATURE');
  requireThat(base58.serialize(value).length === 64, 'INVALID_SIGNATURE');
}
function keys(value, expected) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_RECORD');
  requireThat(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.split(' ').sort()), 'UNEXPECTED_FIELDS');
}

function validateProof(order, item, attempt, proof) {
  const common = 'kind cluster machine collection buyer asset blockhash messageSha256 commitment slot signature';
  const extra = {
    verified: 'account accountSlot',
    failed: 'executionFailed accountAbsent accountSlot',
    expired: 'blockhashValid blockHeight signatureAbsent statusSlot accountAbsent accountSlot addressHistoryEmpty',
  }[proof?.kind];
  requireThat(extra, 'INVALID_PROOF');
  keys(proof, `${common} ${extra}`);
  for (const field of ['cluster', 'machine', 'collection', 'buyer']) requireThat(proof[field] === order[field], 'PROOF_SCOPE_MISMATCH');
  requireThat(proof.asset === item.asset && proof.blockhash === attempt.blockhash && proof.messageSha256 === attempt.messageSha256, 'PROOF_ATTEMPT_MISMATCH');
  requireThat(proof.commitment === 'finalized' && integer(proof.slot) && integer(proof.accountSlot) && proof.accountSlot >= proof.slot, 'PROOF_NOT_FINALIZED');
  requireThat(proof.signature === attempt.signature, 'PROOF_SIGNATURE_MISMATCH');
  if (proof.kind !== 'expired') signature(proof.signature);
  if (proof.kind === 'verified') {
    keys(proof.account, 'program owner collection name uri');
    requireThat(proof.account.program === CORE && proof.account.owner === order.buyer && proof.account.collection === order.collection, 'WRONG_ASSET');
    const match = /\/metadata\/hidden\/(\d{4})\.json$/.exec(proof.account.uri);
    const index = match ? Number(match[1]) : 0;
    requireThat(index >= 1 && index < policy.supply && proof.account.uri === `${policy.website}/metadata/hidden/${match[1]}.json`, 'WRONG_METADATA');
    requireThat(proof.account.name === policy.hiddenName.replace('{index:04d}', match[1]), 'WRONG_METADATA');
  } else if (proof.kind === 'failed') {
    requireThat(proof.executionFailed === true && proof.accountAbsent === true, 'FAILURE_NOT_PROVEN');
  } else {
    requireThat(proof.blockhashValid === false && integer(proof.blockHeight) && proof.blockHeight > attempt.lastValidBlockHeight, 'EXPIRY_NOT_PROVEN');
    requireThat(proof.signatureAbsent === true && proof.accountAbsent === true && proof.addressHistoryEmpty === true && integer(proof.statusSlot) && proof.statusSlot >= proof.slot, 'ABSENCE_NOT_PROVEN');
  }
}

function validateOrder(order) {
  keys(order, 'version kind id revision cluster buyer machine collection guard quantity availableAtPlanning unitPriceLamports totalPriceLamports treasury paused items');
  requireThat(order.version === 1 && order.kind === 'coolbears-offline-order' && idValid(order.id) && integer(order.revision), 'INVALID_ORDER');
  requireThat(['devnet', 'mainnet-beta'].includes(order.cluster), 'INVALID_CLUSTER');
  for (const field of ['buyer', 'machine', 'collection', 'guard', 'treasury']) address(order[field]);
  requireThat(new Set([order.machine, order.collection, order.guard]).size === 3, 'DUPLICATE_ACCOUNTS');
  requireThat(integer(order.quantity, 1) && order.quantity <= policy.maxPerOrder && integer(order.availableAtPlanning) && order.availableAtPlanning <= policy.supply - 1 && order.availableAtPlanning >= order.quantity, 'INVALID_QUANTITY');
  requireThat(order.unitPriceLamports === PRICE && order.totalPriceLamports === String(BigInt(PRICE) * BigInt(order.quantity)) && order.treasury === policy.owner, 'PAYMENT_MISMATCH');
  requireThat(typeof order.paused === 'boolean' && Array.isArray(order.items) && order.items.length === order.quantity, 'INVALID_ITEMS');
  const assets = new Set(), signatures = new Set();
  let active = 0;
  for (const [index, item] of order.items.entries()) {
    keys(item, 'index asset attempts');
    requireThat(item.index === index && Array.isArray(item.attempts), 'INVALID_ITEM');
    address(item.asset);
    requireThat(!assets.has(item.asset) && ![order.buyer, order.treasury, order.machine, order.collection, order.guard].includes(item.asset), 'DUPLICATE_ASSET');
    assets.add(item.asset);
    for (const [number, attempt] of item.attempts.entries()) {
      keys(attempt, 'number state blockhash lastValidBlockHeight messageSha256 signature proof');
      requireThat(attempt.number === number + 1 && STATES.has(attempt.state) && integer(attempt.lastValidBlockHeight, 1) && hashValid(attempt.messageSha256), 'INVALID_ATTEMPT');
      address(attempt.blockhash);
      if (attempt.signature !== null) {
        signature(attempt.signature);
        requireThat(!signatures.has(attempt.signature), 'DUPLICATE_SIGNATURE');
        signatures.add(attempt.signature);
      }
      if (['wallet-pending', 'cancelled'].includes(attempt.state)) requireThat(attempt.signature === null, 'UNEXPECTED_SIGNATURE');
      if (['signed', 'sending', 'submitted', 'verified', 'failed'].includes(attempt.state)) requireThat(attempt.signature !== null, 'MISSING_SIGNATURE');
      if (['verified', 'failed', 'expired'].includes(attempt.state)) {
        requireThat(attempt.proof?.kind === attempt.state, 'MISSING_PROOF');
        validateProof(order, item, attempt, attempt.proof);
      } else requireThat(attempt.proof === null, 'UNEXPECTED_PROOF');
      if (number < item.attempts.length - 1) requireThat(RETRYABLE.has(attempt.state), 'UNRESOLVED_HISTORY');
    }
    if (ACTIVE.has(last(item)?.state)) active++;
  }
  requireThat(active <= 1, 'MULTIPLE_ACTIVE_ATTEMPTS');
  return order;
}

function createOrder({ id, cluster, buyer, machine, collection, guard, quantity, available, assets }) {
  requireThat(Array.isArray(assets), 'INVALID_ASSETS');
  requireThat(integer(quantity, 1), 'INVALID_QUANTITY');
  return validateOrder({
    version: 1, kind: 'coolbears-offline-order', id, revision: 0,
    cluster, buyer, machine, collection, guard, quantity, availableAtPlanning: available,
    unitPriceLamports: PRICE, totalPriceLamports: String(BigInt(PRICE) * BigInt(quantity)),
    treasury: policy.owner, paused: false,
    items: assets.map((asset, index) => ({ index, asset, attempts: [] })),
  });
}

function summarizeOrder(order) {
  validateOrder(order);
  const verified = order.items.filter(item => last(item)?.state === 'verified').length;
  return {
    quantity: order.quantity, verified, remaining: order.quantity - verified,
    listedPriceForVerifiedLamports: String(BigInt(PRICE) * BigInt(verified)),
    totalItemPriceLamports: order.totalPriceLamports,
    feesAndRentQuoted: false, readyToSubmit: false, paused: order.paused,
  };
}

// Reload never turns a wallet/sign/send intent into a fresh attempt.
function nextAction(order) {
  validateOrder(order);
  const unresolved = order.items.find(item => ACTIVE.has(last(item)?.state));
  if (unresolved) return { type: 'reconcile', index: unresolved.index, attempt: last(unresolved).number };
  const item = order.items.find(item => last(item)?.state !== 'verified');
  if (!item) return { type: 'complete' };
  if (order.paused) return { type: 'paused' };
  return { type: last(item) ? 'retry-review' : 'prepare', index: item.index };
}

function itemsToPlan(order, { retry = false } = {}) {
  validateOrder(order);
  requireThat(!order.paused, 'ORDER_PAUSED');
  requireThat(!order.items.some(item => ACTIVE.has(last(item)?.state)), 'RECONCILE_FIRST');
  const pending = order.items.filter(item => last(item)?.state !== 'verified');
  if (pending.length && last(pending[0]) && !retry) throw Error('RETRY_REQUIRES_REVIEW');
  return pending.filter(item => !last(item) || retry);
}

function transitionOrder(order, event) {
  validateOrder(order);
  requireThat(event?.revision === order.revision, 'STALE_REVISION');
  const next = structuredClone(order);
  if (['pause', 'resume'].includes(event.type)) {
    next.paused = event.type === 'pause';
  } else {
    requireThat(integer(event.index) && event.index < next.quantity, 'INVALID_ITEM_INDEX');
    const item = next.items[event.index];
    let attempt = last(item);
    if (event.type === 'prepare') {
      const action = nextAction(next);
      requireThat(['prepare', 'retry-review'].includes(action.type) && action.index === event.index, 'ORDER_NOT_READY');
      if (attempt) requireThat(event.retry === true && RETRYABLE.has(attempt.state), 'RETRY_REQUIRES_REVIEW');
      address(event.blockhash);
      requireThat(integer(event.lastValidBlockHeight, 1) && hashValid(event.messageSha256), 'INVALID_PREPARATION');
      // Expired/failed attempts retain their exact history and stable asset.
      item.attempts.push({ number: item.attempts.length + 1, state: 'wallet-pending',
        blockhash: event.blockhash, lastValidBlockHeight: event.lastValidBlockHeight,
        messageSha256: event.messageSha256, signature: null, proof: null });
    } else {
      requireThat(attempt && event.attempt === attempt.number, 'STALE_ATTEMPT');
      requireThat(attempt.state !== 'verified', 'ITEM_ALREADY_VERIFIED');
      switch (event.type) {
        case 'signature':
          requireThat(['wallet-pending', 'unknown'].includes(attempt.state), 'SIGNATURE_NOT_EXPECTED');
          signature(event.signature);
          requireThat(event.messageSha256 === attempt.messageSha256, 'SIGNED_MESSAGE_MISMATCH');
          requireThat(attempt.signature === null || attempt.signature === event.signature, 'SIGNATURE_CONFLICT');
          attempt.signature = event.signature;
          // A late wallet callback supplies evidence only. It cannot enable send.
          if (attempt.state === 'wallet-pending') attempt.state = 'signed';
          break;
        case 'claim-send':
          requireThat(!next.paused && attempt.state === 'signed', 'SEND_NOT_ALLOWED');
          attempt.state = 'sending';
          break;
        case 'submitted':
          requireThat(attempt.state === 'sending', 'SUBMISSION_NOT_EXPECTED');
          attempt.state = 'submitted';
          break;
        case 'unknown':
          requireThat(ACTIVE.has(attempt.state), 'NO_ACTIVE_ATTEMPT');
          attempt.state = 'unknown';
          break;
        case 'cancelled':
          requireThat(attempt.state === 'wallet-pending' && attempt.signature === null, 'CANNOT_CANCEL_SENT_ATTEMPT');
          attempt.state = 'cancelled';
          next.paused = true;
          break;
        case 'reconcile':
          requireThat(ACTIVE.has(attempt.state), 'NO_ACTIVE_ATTEMPT');
          // Recovery can discover a signature the wallet never returned.
          if (attempt.signature === null && event.proof?.signature != null) attempt.signature = event.proof.signature;
          validateProof(next, item, attempt, event.proof);
          attempt.proof = structuredClone(event.proof);
          attempt.state = event.proof.kind;
          break;
        default: throw Error('UNKNOWN_EVENT');
      }
    }
  }
  next.revision++;
  return validateOrder(next);
}

const storageKey = id => { requireThat(idValid(id), 'INVALID_ORDER_ID'); return `coolbears:offline-order:v1:${id}`; };
function readOrder(storage, id) {
  const raw = storage.getItem(storageKey(id));
  if (raw === null) return null;
  let order;
  try { order = JSON.parse(raw); } catch { throw Error('CORRUPT_ORDER_STORAGE'); }
  validateOrder(order);
  requireThat(order.id === id, 'STORAGE_ORDER_MISMATCH');
  return order;
}

// Compare/read-back protects a single writer from stale callbacks/storage faults.
// This is NOT cross-tab atomic CAS. A live executor must hold an exclusive lock.
function saveOrder(storage, order, expectedRevision = null) {
  validateOrder(order);
  const current = readOrder(storage, order.id);
  if (current === null) {
    requireThat(expectedRevision === null && order.revision === 0, 'MISSING_ORDER');
    requireThat(!order.paused && order.items.every(item => item.attempts.length === 0), 'INITIAL_ORDER_NOT_EMPTY');
  } else {
    requireThat(current.revision === expectedRevision && order.revision === expectedRevision + 1, 'STALE_REVISION');
    for (const field of ['version', 'kind', 'id', 'cluster', 'buyer', 'machine', 'collection', 'guard', 'quantity', 'availableAtPlanning', 'unitPriceLamports', 'totalPriceLamports', 'treasury']) {
      requireThat(current[field] === order[field], 'ORDER_SCOPE_CHANGED');
    }
    let changedItems = 0;
    for (const [index, before] of current.items.entries()) {
      const after = order.items[index];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      changedItems++;
      requireThat(before.asset === after.asset && after.attempts.length >= before.attempts.length, 'HISTORY_CHANGED');
      const frozenCount = before.attempts.length - (ACTIVE.has(last(before)?.state) ? 1 : 0);
      for (let n = 0; n < frozenCount; n++) {
        requireThat(JSON.stringify(before.attempts[n]) === JSON.stringify(after.attempts[n]), 'HISTORY_CHANGED');
      }
      if (ACTIVE.has(last(before)?.state)) {
        const old = last(before), replacement = after.attempts[before.attempts.length - 1];
        requireThat(after.attempts.length === before.attempts.length, 'UNRESOLVED_HISTORY');
        for (const key of ['number', 'blockhash', 'lastValidBlockHeight', 'messageSha256']) requireThat(old[key] === replacement[key], 'ATTEMPT_CHANGED');
        if (old.signature) requireThat(old.signature === replacement.signature, 'SIGNATURE_CONFLICT');
        requireThat(ALLOWED_NEXT[old.state].includes(replacement.state), 'ATTEMPT_REGRESSION');
        if (replacement.state === 'sending') requireThat(!current.paused, 'ORDER_PAUSED');
      } else {
        const action = nextAction(current);
        requireThat(['prepare', 'retry-review'].includes(action.type) && action.index === index && after.attempts.length === before.attempts.length + 1 && last(after).state === 'wallet-pending', 'HISTORY_CHANGED');
      }
      requireThat(current.paused === order.paused || (!current.paused && order.paused && last(after).state === 'cancelled'), 'MULTIPLE_EVENTS');
    }
    requireThat(changedItems <= 1, 'MULTIPLE_EVENTS');
  }
  const key = storageKey(order.id), raw = JSON.stringify(order);
  storage.setItem(key, raw);
  requireThat(storage.getItem(key) === raw, 'ORDER_NOT_SAVED');
  return order;
}

return { validateOrder, createOrder, summarizeOrder, nextAction, itemsToPlan, transitionOrder, readOrder, saveOrder };
}
