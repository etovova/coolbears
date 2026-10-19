// A real wallet invocation remains part of the input; no prewallet claim is synthesized.
import {validateMissingBuyerResponse} from './response-recovery.mjs';
import {responseExpiryReport} from './response-expiry.mjs';
import {reviewUnknownSignatureAbsence} from './review-absence.mjs';
export async function reviewResponseExpiry(options){
  const input=structuredClone(options.input);validateMissingBuyerResponse(input);
  return responseExpiryReport(input,await reviewUnknownSignatureAbsence({...options,input}));
}
