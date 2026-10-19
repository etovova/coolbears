// Node adapter retains the existing operator policy instance.
import { policy } from '../prepare.mjs';
import { createAccountVerifier } from './accounts-model.mjs';
export const { expectedAccountAddresses, verifyOrderAccounts, verifyExpectedAccounts } = createAccountVerifier(policy);
