// Offline handoff integrity only. A request is not authorization: its deployment,
// step and message must be bound to the caller's separately reviewed manifest.
// Keep the exact prepared bytes and accepted signed bytes in the durable journal.
// Nothing here opens a wallet, creates keys, signs, checks expiry or uses RPC.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@metaplex-foundation/umi/serializers';

const PACKET_LIMIT = 1232;
const INPUT_KEYS = ['deploymentId', 'stepId', 'attempt', 'cluster', 'owner', 'transactionBase64', 'lastValidBlockHeight'];
const REQUEST_KEYS = [...INPUT_KEYS, 'version', 'kind', 'blockhash', 'messageSha256', 'requiredSigners'];
const KIND = 'coolbears-deployment-signing-request';
const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const sameStrings = (a, b) => Array.isArray(a) && a.length === b.length
  && Reflect.ownKeys(a).length === a.length + 1
  && b.every((item, index) => Object.hasOwn(a, index)
    && Object.getOwnPropertyDescriptor(a, index)?.value === item);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValid(condition, message) {
  if (!condition) throw Object.assign(Error(message), { code: 'DEPLOYMENT_SIGNING_INVALID' });
}
function exactRecord(value, keys) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Invalid signing record.');
  const actual = Reflect.ownKeys(value);
  requireValid(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && actual.every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined),
  'Invalid signing record fields.');
}
function publicAddress(value) {
  let valid = false;
  try { valid = typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { /* Fail closed. */ }
  requireValid(valid, 'Invalid signing public address.');
  return value;
}
function primeOrderPoint(bytes) {
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch { return false; }
}
function signatureValid(message, signature, key) {
  try {
    // Strict canonical Ed25519 points and scalar; do not use ZIP-215's relaxed
    // small-order acceptance. The deployment protocol accepts ordinary keys.
    return primeOrderPoint(signature.subarray(0, 32))
      && ed25519.verify(signature, message, key.toBytes(), { zip215: false });
  } catch { return false; }
}
function canonicalTransaction(transactionBase64) {
  requireValid(typeof transactionBase64 === 'string' && transactionBase64.length > 0
    && transactionBase64.length <= Math.ceil(PACKET_LIMIT / 3) * 4, 'Invalid transaction encoding or size.');
  const bytes = Buffer.from(transactionBase64, 'base64');
  requireValid(bytes.length > 0 && bytes.length <= PACKET_LIMIT
    && bytes.toString('base64') === transactionBase64, 'Invalid transaction encoding or size.');
  let transaction, canonical;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
    canonical = transaction.serialize();
  } catch {
    requireValid(false, 'Invalid serialized transaction.');
  }
  requireValid([0, 'legacy'].includes(transaction.version) && sameBytes(bytes, canonical), 'Noncanonical transaction.');
  const { message, signatures } = transaction;
  requireValid((message.addressTableLookups ?? []).length === 0, 'Address lookup tables are outside this signing protocol.');
  const keys = message.staticAccountKeys;
  const { numRequiredSignatures: count, numReadonlySignedAccounts: readonlySigned, numReadonlyUnsignedAccounts: readonlyUnsigned } = message.header;
  requireValid(Number.isInteger(count) && count >= 1 && count <= keys.length
    && readonlySigned >= 0 && readonlySigned < count
    && readonlyUnsigned >= 0 && readonlyUnsigned <= keys.length - count
    && signatures.length === count, 'Invalid transaction signer header.');
  requireValid(new Set(keys.map(key => key.toBase58())).size === keys.length, 'Duplicate transaction accounts.');
  requireValid(signatures.every(signature => signature instanceof Uint8Array && signature.length === 64), 'Invalid transaction signatures.');
  requireValid(keys.slice(0, count).every(key => primeOrderPoint(key.toBytes())), 'Invalid transaction signer key.');
  requireValid(message.compiledInstructions.every(instruction => instruction.programIdIndex > 0
    && instruction.programIdIndex < keys.length
    && [...instruction.accountKeyIndexes].every(index => index >= 0 && index < keys.length)), 'Invalid transaction account indexes.');
  publicAddress(message.recentBlockhash);
  return {
    transaction, messageBytes: message.serialize(),
    transactionBase64: Buffer.from(canonical).toString('base64'),
    requiredSigners: keys.slice(0, count).map(key => key.toBase58()),
  };
}

export function createSigningRequest(input) {
  exactRecord(input, INPUT_KEYS);
  const { deploymentId, stepId, attempt, cluster, owner, transactionBase64, lastValidBlockHeight } = input;
  requireValid([deploymentId, stepId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)), 'Invalid deployment or step identifier.');
  requireValid(Number.isSafeInteger(attempt) && attempt >= 1, 'Invalid signing attempt.');
  requireValid(['devnet', 'mainnet-beta'].includes(cluster), 'Invalid signing cluster label.');
  publicAddress(owner);
  requireValid(Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight >= 1, 'Invalid last valid block height.');
  const parsed = canonicalTransaction(transactionBase64);
  const { transaction, messageBytes, requiredSigners } = parsed;
  requireValid(requiredSigners[0] === owner, 'Owner must be the first signer and fee payer.');
  requireValid(transaction.signatures[0].every(byte => byte === 0), 'Prepared transaction already contains an owner signature.');
  for (let index = 1; index < requiredSigners.length; index++) {
    requireValid(signatureValid(messageBytes, transaction.signatures[index], transaction.message.staticAccountKeys[index]),
      'Prepared transaction is missing a valid non-owner signature.');
  }
  return Object.freeze({
    version: 1, kind: KIND, deploymentId, stepId, attempt, cluster, owner,
    transactionBase64: parsed.transactionBase64, lastValidBlockHeight,
    blockhash: transaction.message.recentBlockhash, messageSha256: digest(messageBytes),
    requiredSigners: Object.freeze(requiredSigners),
  });
}

export function verifySigningResponse(request, response) {
  exactRecord(request, REQUEST_KEYS);
  const expected = createSigningRequest(Object.fromEntries(INPUT_KEYS.map(key => [key, request[key]])));
  requireValid(request.version === expected.version && request.kind === expected.kind
    && request.blockhash === expected.blockhash && request.messageSha256 === expected.messageSha256
    && sameStrings(request.requiredSigners, expected.requiredSigners), 'Signing request metadata does not match its transaction.');
  exactRecord(response, ['transactionBase64']);
  const prepared = canonicalTransaction(expected.transactionBase64);
  const signed = canonicalTransaction(response.transactionBase64);
  requireValid(sameBytes(prepared.messageBytes, signed.messageBytes)
    && sameStrings(signed.requiredSigners, expected.requiredSigners), 'Wallet changed the transaction message or signers.');
  for (let index = 0; index < signed.requiredSigners.length; index++) {
    const signature = signed.transaction.signatures[index];
    if (index > 0) requireValid(sameBytes(signature, prepared.transaction.signatures[index]), 'Wallet changed a non-owner signature.');
    requireValid(signatureValid(signed.messageBytes, signature, signed.transaction.message.staticAccountKeys[index]), 'Signed transaction contains an invalid or missing signature.');
  }
  return Object.freeze({
    transactionBase64: signed.transactionBase64,
    signature: base58.deserialize(signed.transaction.signatures[0])[0],
    messageSha256: expected.messageSha256, blockhash: expected.blockhash,
    requiredSigners: expected.requiredSigners,
  });
}
