import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { settings } from '../devnet/settings.mjs';

export const ORIGIN = 'https://coolbears-nfts.com';
export const OBJECT_NAME = 'coolbears-devnet-v1';
export const LAB = Object.freeze({
  owner: settings.owner, machine: settings.machine, guard: settings.guard,
  collection: settings.collection, genesis: settings.genesis,
  machineAuthority: '41w1RrRLAMhZCbsrEwfLuwzAwg9XUZeR24hLcH4XLJQP',
});
export const LIMITS = Object.freeze({
  requestBytes: 8192, responseBytes: 131072,
  requestTimeoutMs: 4000, upstreamTimeoutMs: 12000,
  startIntervalMs: 130, sendIntervalMs: 1100,
  dailyCredits: 20000, perIpDailyCredits: 1000, dailySimulations: 1000, perIpDailySimulations: 200,
});
export const ALLOWED_METHODS = Object.freeze([
  'getGenesisHash', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash',
  'simulateTransaction', 'getBlockHeight', 'getSignaturesForAddress',
  'getSignatureStatuses', 'getAccountInfo', 'isBlockhashValid', 'sendTransaction',
]);

export class ProxyError extends Error {
  constructor(category, status = 400, { retryAfter, rpcCode } = {}) {
    super('CoolBears Devnet RPC request unavailable.'); this.name = 'ProxyError';
    this.category = category; this.status = status;
    if (Number.isSafeInteger(retryAfter) && retryAfter > 0) this.retryAfter = retryAfter;
    if ([-32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32003, -32004, -32005, -32006, -32007, -32008, -32009, -32010, -32011, -32012, -32013, -32014, -32015, -32016].includes(rpcCode)) this.rpcCode = rpcCode;
  }
}
const fail = (condition, category = 'INVALID_REQUEST') => { if (!condition) throw new ProxyError(category); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, allowed, required = allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const address = value => {
  try { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && new PublicKey(value).toBase58() === value; } catch { return false; }
};
const signature = value => {
  try { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) && base58.serialize(value).length === 64; } catch { return false; }
};
function config(value, { encoding = false, commitment = ['confirmed', 'finalized'], slot = false } = {}) {
  const fields = ['commitment', ...(encoding ? ['encoding'] : []), ...(slot ? ['minContextSlot'] : [])];
  return exact(value, fields, ['commitment', ...(encoding ? ['encoding'] : [])]) && commitment.includes(value.commitment) && (!encoding || value.encoding === 'base64') && (!Object.hasOwn(value, 'minContextSlot') || uint(value.minContextSlot));
}
function decodeBase64(value, maxBytes) {
  fail(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maxBytes / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  let raw;
  try { raw = atob(value); } catch { throw new ProxyError('INVALID_REQUEST'); }
  fail(raw.length <= maxBytes && btoa(raw) === value);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function validSignature(bytes, publicKey, message) {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey.toBytes(), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes, message);
  } catch { return false; }
}
export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function transactionDetails(encoded, sending, lab) {
  const bytes = decodeBase64(encoded, 1232);
  let tx;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { throw new ProxyError('INVALID_TRANSACTION'); }
  const { message } = tx;
  fail(tx.version === 0 && same(bytes, tx.serialize()), 'INVALID_TRANSACTION');
  fail(message.addressTableLookups.length === 0 && message.header.numRequiredSignatures === 2 && message.header.numReadonlySignedAccounts === 0 && message.header.numReadonlyUnsignedAccounts === 8 && tx.signatures.length === 2, 'INVALID_TRANSACTION');
  const keys = message.staticAccountKeys.map(key => key.toBase58());
  fail(keys.length === 13 && address(keys[1]) && keys[1] !== lab.owner, 'INVALID_TRANSACTION');
  const expectedKeys = [lab.owner, keys[1], lab.machine, lab.machineAuthority, lab.collection,
    'ComputeBudget111111111111111111111111111111', 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
    lab.guard, 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
    '11111111111111111111111111111111', 'Sysvar1nstructions1111111111111111111111111', 'SysvarS1otHashes111111111111111111111111111'];
  fail(same(keys, expectedKeys), 'TRANSACTION_SCOPE');
  const [compute, mint] = message.compiledInstructions;
  fail(message.compiledInstructions.length === 2 && compute.programIdIndex === 5 && compute.accountKeyIndexes.length === 0 && same(compute.data, [2, 224, 147, 4, 0]), 'TRANSACTION_SCOPE');
  fail(mint.programIdIndex === 6 && same(mint.accountKeyIndexes, [7, 8, 2, 3, 0, 0, 0, 1, 4, 9, 10, 11, 12, 0]) && same(mint.data, [145, 98, 192, 118, 184, 147, 118, 104, 0, 0, 0, 0, 0]), 'TRANSACTION_SCOPE');
  const serialized = message.serialize();
  fail(await validSignature(tx.signatures[1], message.staticAccountKeys[1], serialized), 'INVALID_SIGNATURE');
  if (sending) fail(await validSignature(tx.signatures[0], message.staticAccountKeys[0], serialized), 'INVALID_SIGNATURE');
  else fail(tx.signatures[0].every(byte => byte === 0), 'INVALID_SIGNATURE');
  return sending ? { signature: base58.deserialize(tx.signatures[0])[0], hash: await digest(bytes) } : null;
}

// The optional lab override exists only for offline tests with disposable keys.
// Worker configuration and HTTP input never accept an owner or cluster override.
export async function validateRpcRequest(data, { lab = LAB } = {}) {
  fail(exact(data, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'id', 'method']) && data.jsonrpc === '2.0');
  fail((Number.isSafeInteger(data.id) && data.id >= 0) || (typeof data.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.id)));
  fail(ALLOWED_METHODS.includes(data.method), 'METHOD_NOT_ALLOWED');
  const params = data.params ?? [];
  fail(Array.isArray(params));
  const [first, second] = params;
  let send = null;
  switch (data.method) {
    case 'getGenesisHash': fail(params.length === 0); break;
    case 'getMultipleAccounts':
      fail(params.length === 2 && Array.isArray(first) && same(first, [lab.machine, lab.guard, lab.collection]) && config(second, { encoding: true, commitment: ['finalized'] })); break;
    case 'getBalance': fail(params.length === 2 && first === lab.owner && config(second, { commitment: ['confirmed'] })); break;
    case 'getLatestBlockhash': fail(params.length === 1 && config(first, { commitment: ['confirmed'] })); break;
    case 'getBlockHeight': fail(params.length === 1 && config(first)); break;
    case 'getSignaturesForAddress':
      fail(params.length === 2 && address(first) && exact(second, ['limit', 'commitment', 'minContextSlot'], ['limit', 'commitment']) && uint(second.limit) && second.limit >= 1 && second.limit <= 10 && second.commitment === 'finalized' && (!Object.hasOwn(second, 'minContextSlot') || uint(second.minContextSlot))); break;
    case 'getSignatureStatuses': fail(params.length === 2 && Array.isArray(first) && first.length === 1 && signature(first[0]) && exact(second, ['searchTransactionHistory']) && second.searchTransactionHistory === true); break;
    case 'getAccountInfo': fail(params.length === 2 && address(first) && config(second, { encoding: true, commitment: ['finalized'], slot: true })); break;
    case 'isBlockhashValid': fail(params.length === 2 && address(first) && config(second)); break;
    case 'simulateTransaction':
      fail(params.length === 2 && exact(second, ['encoding', 'sigVerify', 'commitment']) && second.encoding === 'base64' && second.sigVerify === false && second.commitment === 'confirmed');
      await transactionDetails(first, false, lab); break;
    case 'sendTransaction':
      fail(params.length === 2 && exact(second, ['encoding', 'preflightCommitment', 'skipPreflight', 'maxRetries']) && second.encoding === 'base64' && second.preflightCommitment === 'confirmed' && second.skipPreflight === false && second.maxRetries === 5);
      send = await transactionDetails(first, true, lab); break;
  }
  return { request: { jsonrpc: '2.0', id: data.id, method: data.method, params }, cost: 1, send };
}

function responseCheck(condition) { if (!condition) throw new ProxyError('UPSTREAM_RESPONSE', 502); }
function context(value) {
  responseCheck(object(value) && uint(value.slot)); return { slot: value.slot };
}
function account(value) {
  if (value === null) return null;
  // Solana's rent-exempt sentinel is u64::MAX; JSON represents it as a rounded
  // number. It is metadata, never an arithmetic input to mint/recovery logic.
  const rentEpoch = Number.isInteger(value?.rentEpoch) && value.rentEpoch >= 0 && value.rentEpoch <= 18446744073709552000;
  responseCheck(object(value) && uint(value.lamports) && typeof value.executable === 'boolean' && address(value.owner) && rentEpoch && Array.isArray(value.data) && value.data.length === 2 && value.data[1] === 'base64');
  try { if (value.data[0] !== '') decodeBase64(value.data[0], LIMITS.responseBytes); } catch { throw new ProxyError('UPSTREAM_RESPONSE', 502); }
  return { lamports: value.lamports, executable: value.executable, owner: value.owner, rentEpoch: value.rentEpoch, data: value.data, ...(uint(value.space) ? { space: value.space } : {}) };
}
const transactionError = value => value === null ? null : { ProxyTransactionError: true };

// Successful results are projected onto the fields the site needs. Provider
// error messages/data, logs, memos and arbitrary extension fields never escape.
export function sanitizeRpcResponse(data, validated, { lab = LAB } = {}) {
  const { request, send } = validated;
  responseCheck(object(data) && data.jsonrpc === '2.0' && data.id === request.id);
  if (Object.hasOwn(data, 'error')) {
    responseCheck(!Object.hasOwn(data, 'result') && object(data.error));
    throw new ProxyError('UPSTREAM_RPC', 200, { rpcCode: data.error.code });
  }
  responseCheck(Object.hasOwn(data, 'result'));
  const value = data.result;
  let result;
  switch (request.method) {
    case 'getGenesisHash': responseCheck(value === lab.genesis); result = value; break;
    case 'getBlockHeight': responseCheck(uint(value)); result = value; break;
    case 'getBalance': responseCheck(object(value) && uint(value.value)); result = { context: context(value.context), value: value.value }; break;
    case 'getLatestBlockhash': responseCheck(object(value) && object(value.value) && address(value.value.blockhash) && uint(value.value.lastValidBlockHeight)); result = { context: context(value.context), value: { blockhash: value.value.blockhash, lastValidBlockHeight: value.value.lastValidBlockHeight } }; break;
    case 'isBlockhashValid': responseCheck(object(value) && typeof value.value === 'boolean'); result = { context: context(value.context), value: value.value }; break;
    case 'getAccountInfo': responseCheck(object(value)); result = { context: context(value.context), value: account(value.value) }; break;
    case 'getMultipleAccounts': responseCheck(object(value) && Array.isArray(value.value) && value.value.length === 3); result = { context: context(value.context), value: value.value.map(account) }; break;
    case 'getSignatureStatuses':
      responseCheck(object(value) && Array.isArray(value.value) && value.value.length === 1);
      result = { context: context(value.context), value: value.value.map(status => {
        if (status === null) return null;
        responseCheck(object(status) && uint(status.slot) && (status.confirmations === null || uint(status.confirmations)) && ['processed', 'confirmed', 'finalized'].includes(status.confirmationStatus) && Object.hasOwn(status, 'err'));
        return { slot: status.slot, confirmations: status.confirmations, confirmationStatus: status.confirmationStatus, err: transactionError(status.err) };
      }) }; break;
    case 'getSignaturesForAddress':
      responseCheck(Array.isArray(value) && value.length <= request.params[1].limit);
      result = value.map(entry => {
        responseCheck(object(entry) && signature(entry.signature) && uint(entry.slot) && Object.hasOwn(entry, 'err'));
        return { signature: entry.signature, slot: entry.slot, err: transactionError(entry.err), ...(uint(entry.blockTime) ? { blockTime: entry.blockTime } : { blockTime: null }), confirmationStatus: 'finalized', memo: null };
      }); break;
    case 'simulateTransaction':
      responseCheck(object(value) && object(value.value) && Object.hasOwn(value.value, 'err'));
      result = { context: context(value.context), value: { err: transactionError(value.value.err), logs: [], ...(uint(value.value.unitsConsumed) ? { unitsConsumed: value.value.unitsConsumed } : {}) } }; break;
    case 'sendTransaction': responseCheck(value === send.signature); result = value; break;
    default: throw new ProxyError('UPSTREAM_RESPONSE', 502);
  }
  return { jsonrpc: '2.0', id: request.id, result };
}
