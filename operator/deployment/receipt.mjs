// Pure verification of supplied RPC results, not a network/finality oracle.
// The trusted read orchestrator must query the saved signature on the bound
// cluster using getSignatureStatuses(searchTransactionHistory: true) and
// getTransaction(commitment: 'finalized', encoding: 'base64',
// maxSupportedTransactionVersion: 0). Neither response proves those query
// parameters or the RPC's honesty. Deployment account effects need a separate
// verification; this receipt only binds finalized success to the exact bytes.
import { VersionedTransaction } from '@solana/web3.js';
import { verifySigningResponse } from './signing.mjs';

const ERROR_CODE = 'DEPLOYMENT_RECEIPT_INVALID';
const ERROR_MESSAGE = 'Finalized transaction receipt could not be verified.';
const SIGNED_FIELDS = ['transactionBase64', 'signature', 'messageSha256', 'blockhash', 'requiredSigners'];
function check(value) { if (!value) throw Error(ERROR_MESSAGE); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function field(value, name) {
  check(record(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  check(descriptor && Object.hasOwn(descriptor, 'value'));
  return descriptor.value;
}
function exactRecord(value, names) {
  check(record(value) && Reflect.ownKeys(value).length === names.length);
  for (const name of names) field(value, name);
}
function array(value, length) {
  check(Array.isArray(value) && value.length === length && Reflect.ownKeys(value).length === length + 1);
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    check(descriptor && Object.hasOwn(descriptor, 'value'));
  }
  return value;
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

export function verifyFinalizedReceipt(input) {
  try {
    exactRecord(input, ['request', 'signed', 'statusResult', 'transactionResult']);
    const { request, signed, statusResult, transactionResult } = input;
    exactRecord(signed, SIGNED_FIELDS);
    const verified = verifySigningResponse(request, { transactionBase64: signed.transactionBase64 });
    for (const name of SIGNED_FIELDS.filter(name => name !== 'requiredSigners')) check(signed[name] === verified[name]);
    array(signed.requiredSigners, verified.requiredSigners.length);
    check(verified.requiredSigners.every((address, index) => address === signed.requiredSigners[index]));

    const contextSlot = field(field(statusResult, 'context'), 'slot');
    const [status] = array(field(statusResult, 'value'), 1);
    const slot = field(status, 'slot');
    check(positiveInteger(slot) && positiveInteger(contextSlot) && slot <= contextSlot);
    check(field(status, 'confirmationStatus') === 'finalized'
      && field(status, 'confirmations') === null && field(status, 'err') === null);
    // Older RPCs may also include this deprecated result. Reject contradictory
    // failure information even when the modern err field says null.
    if (Object.hasOwn(status, 'status')) {
      const legacyStatus = field(status, 'status');
      exactRecord(legacyStatus, ['Ok']);
      check(legacyStatus.Ok === null);
    }

    check(field(transactionResult, 'slot') === slot);
    check(field(field(transactionResult, 'meta'), 'err') === null);
    const transaction = VersionedTransaction.deserialize(Buffer.from(verified.transactionBase64, 'base64'));
    check(field(transactionResult, 'version') === transaction.version);
    const returned = array(field(transactionResult, 'transaction'), 2);
    // verified.transactionBase64 is canonical full wire data. Equality checks
    // every signature and every message byte, not a response's claimed tx ID.
    check(returned[1] === 'base64' && returned[0] === verified.transactionBase64);
    return Object.freeze({ slot, signature: verified.signature, messageSha256: verified.messageSha256 });
  } catch {
    // Do not expose provider responses, encoded transactions or nested errors.
    throw Object.assign(Error(ERROR_MESSAGE), { code: ERROR_CODE });
  }
}
