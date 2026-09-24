// Exact intent/byte binding only. No network trust, wallet invocation or sending.
import policy from '../../metadata/policy.json' with { type: 'json' };
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createOrderModel } from './journal-model.mjs';
import { createOrderPlanner } from './transaction-model.mjs';
import { createSigningRequest, verifySigningResponse } from '../deployment/signing.mjs';
const model = createOrderModel(policy), planner = createOrderPlanner(model);
const need = (ok, code) => { if (!ok) throw Error(code); };
const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const digest = value => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const CLAIM = 'coolbears-buyer-asset-claim', PARTIAL = 'coolbears-buyer-asset-partial';
const BINDING = ['version','kind','orderId','orderRevision','orderIdentitySha256','cluster','buyer','machine','collection','guard','itemIndex','asset','attempt','blockhash','lastValidBlockHeight','messageSha256','transactionBase64'];
function exact(value, names) {
  need(value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name) && Object.getOwnPropertyDescriptor(value, name)?.value !== undefined), 'SIGNING_FIELDS');
}
function bytes(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 1644, 'TRANSACTION_ENCODING');
  const decoded = new Uint8Array(Buffer.from(value, 'base64'));
  need(decoded.length <= 1232 && Buffer.from(decoded).toString('base64') === value, 'TRANSACTION_ENCODING');
  return decoded;
}
function ordinaryKey(address) {
  try { const p = ed25519.Point.fromBytes(new PublicKey(address).toBytes(), false); return !p.isSmallOrder() && p.isTorsionFree(); }
  catch { return false; }
}
function identity(order) {
  // Immutable scope and all assets; history is separately bound to the attempt.
  const fields = ['version','kind','id','cluster','buyer','machine','collection','guard','quantity','availableAtPlanning','unitPriceLamports','totalPriceLamports','treasury'];
  return digest({ ...Object.fromEntries(fields.map(field => [field, order[field]])),
    items: order.items.map(({index,asset}) => ({index,asset})) });
}
function context(order) {
  model.validateOrder(order);
  need(order.cluster === 'devnet', 'DEVNET_ONLY');
  need(ordinaryKey(order.buyer) && order.items.every(item => ordinaryKey(item.asset)), 'UNSIGNABLE_ADDRESS');
}
function internalRequest(record) {
  // Reuse the strict wire/signature verifier, after independent buyer intent
  // reconstruction below. No deployment request is issued or persisted here.
  return createSigningRequest({ deploymentId: record.orderId, stepId: `item-${record.itemIndex}`,
    attempt: record.attempt, cluster: record.cluster, owner: record.buyer,
    transactionBase64: record.transactionBase64, lastValidBlockHeight: record.lastValidBlockHeight });
}
export function prepareAssetClaim(order, input) {
  context(order);
  exact(input, ['orderRevision','itemIndex','blockhash','lastValidBlockHeight','transactionBase64']);
  need(input.orderRevision === order.revision, 'STALE_REVISION');
  const prior=order.items[0].attempts,number=prior.length+1;
  need(!order.paused&&order.items.slice(1).every(item=>!item.attempts.length)
    &&((number===1&&order.revision===0)||(number===2&&prior[0].state==='expired')), 'FRESH_ORDER_REQUIRED');
  if(number===2)need(input.blockhash!==prior[0].blockhash,'REPLACEMENT_HASH_REQUIRED');
  need(input.itemIndex === 0, 'FIRST_ITEM_REQUIRED');
  const template = planner.buildOrderItemTemplate(order, 0, input);
  need(same(bytes(input.transactionBase64), template.unsignedBytes), 'ORDER_MESSAGE_MISMATCH');
  const event = { type:'prepare', revision:order.revision, index:0, blockhash:input.blockhash,
    lastValidBlockHeight:input.lastValidBlockHeight, messageSha256:template.messageSha256,...(number===2?{retry:true}:{}) };
  const preparedOrder = model.transitionOrder(order, event);
  const claim = { version:1, kind:CLAIM, orderId:order.id, orderRevision:preparedOrder.revision,
    orderIdentitySha256:identity(order), cluster:order.cluster, buyer:order.buyer,
    machine:order.machine, collection:order.collection, guard:order.guard,
    itemIndex:0, asset:order.items[0].asset, attempt:number, blockhash:input.blockhash,
    lastValidBlockHeight:input.lastValidBlockHeight, messageSha256:template.messageSha256,
    transactionBase64:input.transactionBase64 };
  return { order:preparedOrder, event, claim };
}
export function validateAssetClaim(order, claim) {
  context(order); exact(claim, BINDING);
  need(claim.version === 1 && claim.kind === CLAIM && claim.itemIndex === 0 && [1,2].includes(claim.attempt)
    && Number.isSafeInteger(claim.orderRevision)&&order.revision>=claim.orderRevision
    &&(claim.attempt===1?claim.orderRevision===1:claim.orderRevision>=5), 'ASSET_CLAIM_BINDING');
  if(claim.attempt===2)need(order.items[0].attempts[0].state==='expired'
    &&order.items[0].attempts[0].blockhash!==claim.blockhash,'REPLACEMENT_HASH_REQUIRED');
  need(order.items[0].attempts.length<=2&&order.items.slice(1).every(item=>!item.attempts.length),'ASSET_CLAIM_BINDING');
  need(claim.orderId === order.id && claim.orderIdentitySha256 === identity(order)
    && ['cluster','buyer','machine','collection','guard'].every(key => claim[key] === order[key])
    && claim.asset === order.items[0].asset, 'ASSET_CLAIM_BINDING');
  const attempt = order.items[0].attempts[claim.attempt-1];
  need(attempt && attempt.number === claim.attempt && ['blockhash','lastValidBlockHeight','messageSha256'].every(key => attempt[key] === claim[key]), 'ASSET_CLAIM_BINDING');
  const template = planner.buildOrderItemTemplate(order, 0, claim);
  need(template.messageSha256 === claim.messageSha256 && same(bytes(claim.transactionBase64), template.unsignedBytes), 'ORDER_MESSAGE_MISMATCH');
  return VersionedTransaction.deserialize(template.unsignedBytes).message.serialize();
}
export function finalizeAssetRequest(order, claim, assetSignature) {
  validateAssetClaim(order, claim);
  need(assetSignature instanceof Uint8Array && assetSignature.length === 64, 'ASSET_SIGNATURE_INVALID');
  const tx = VersionedTransaction.deserialize(bytes(claim.transactionBase64));
  tx.signatures[1] = new Uint8Array(assetSignature);
  const request = { ...claim, kind:PARTIAL, transactionBase64:Buffer.from(tx.serialize()).toString('base64') };
  validateAssetRequest(order, claim, request);
  return request;
}
export function validateAssetRequest(order, claim, request) {
  const message = validateAssetClaim(order, claim); exact(request, BINDING);
  need(request.kind === PARTIAL && BINDING.filter(key => !['kind','transactionBase64'].includes(key)).every(key => request[key] === claim[key]), 'ASSET_REQUEST_BINDING');
  const parsed = VersionedTransaction.deserialize(bytes(request.transactionBase64));
  need(same(parsed.message.serialize(), message), 'ORDER_MESSAGE_MISMATCH');
  const verified = internalRequest(request);
  need(verified.messageSha256 === claim.messageSha256 && verified.requiredSigners.length === 2
    && verified.requiredSigners[1] === claim.asset, 'ASSET_SIGNATURE_INVALID');
  return request;
}
export function verifyBuyerSigningResponse(order, claim, request, response) {
  const attempt = order.items[0].attempts.at(-1);
  need(attempt?.number === claim.attempt && ['wallet-pending','unknown'].includes(attempt.state), 'BUYER_RESPONSE_NOT_EXPECTED');
  return verifyBuyerEvidence(order,claim,request,response);
}
// Historical verification supplies evidence only; it never authorizes a wallet or send.
export function verifyBuyerEvidence(order,claim,request,response){
  validateAssetRequest(order, claim, request);
  const attempt=order.items[0].attempts[claim.attempt-1];
  const verified = verifySigningResponse(internalRequest(request), response);
  need(attempt.signature === null || attempt.signature === verified.signature, 'BUYER_SIGNATURE_CONFLICT');
  return { ...verified, orderId:order.id, orderRevision:order.revision, itemIndex:0, attempt:claim.attempt,
    // A valid signature is neither a fresh preflight nor an execution proof.
    mode:'offline-buyer-response-check', networkVerified:false, blockhashVerified:false, guardPriceVerified:false,
    readyToSubmit:false, salesOpen:false };
}

// Canonical immutable request identity for wallet claims and trusted check responses.
export function buyerRequestId(request) {
  exact(request, BINDING);
  return digest(Object.fromEntries(BINDING.map(key => [key, request[key]])));
}
