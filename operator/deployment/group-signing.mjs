// Portable group integrity for the journal and browser. Not an intent validator.
import { sha256 } from '@noble/hashes/sha256';
import { validateSigningRequest, verifySigningResponse } from './signing.mjs';
export const MAX_SIGNING_GROUP = 4;
const need = value => { if (!value) throw Error('INVALID_SIGNING_GROUP'); };
export function validateSigningGroup(requests) {
  need(Array.isArray(requests) && requests.length >= 2 && requests.length <= MAX_SIGNING_GROUP);
  const normalized = Array.from(requests, validateSigningRequest), first = normalized[0];
  need(first.cluster === 'devnet');
  let previous;
  for (const request of normalized) {
    need(/^insert-\d{4}$/.test(request.stepId) && request.attempt === 1
      && request.deploymentId === first.deploymentId && request.owner === first.owner
      && request.cluster === first.cluster && request.blockhash === first.blockhash
      && request.lastValidBlockHeight === first.lastValidBlockHeight
      && request.requiredSigners.length === 1 && request.requiredSigners[0] === first.owner);
    const index = Number(request.stepId.slice(7));
    need(previous === undefined || index === previous + 1); previous = index;
  }
  return normalized;
}
export function signingGroupId(requests) {
  return Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(validateSigningGroup(requests))))).toString('hex');
}
export function verifySigningGroupResponse(requests, transactionBase64s) {
  const normalized = validateSigningGroup(requests);
  need(Array.isArray(transactionBase64s) && transactionBase64s.length === normalized.length);
  // Verify every output in exact input order before returning any accepted bytes.
  return normalized.map((request, i) => verifySigningResponse(request, { transactionBase64: transactionBase64s[i] }));
}
