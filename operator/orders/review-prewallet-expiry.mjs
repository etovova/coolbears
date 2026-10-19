// Explicit prewallet input validation stays separate from the shared absence algorithm.
import {validatePrewalletInput} from './prewallet-recovery.mjs';
import {prewalletExpiryReport} from './prewallet-expiry.mjs';
import {reviewUnknownSignatureAbsence} from './review-absence.mjs';
export async function reviewPrewalletExpiry(options){
  const input=structuredClone(options.input);validatePrewalletInput(input);
  return prewalletExpiryReport(input,await reviewUnknownSignatureAbsence({...options,input}));
}
