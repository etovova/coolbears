// Node adapter preserves existing CLI imports and operator policy.
import { policy } from '../prepare.mjs';
import { validateOrder } from './journal.mjs';
import { buildOrderTransactions } from './transactions.mjs';
import { verifyOrderAccounts } from '../deployment/accounts.mjs';
import { createOrderChecker } from './preflight-model.mjs';
export const { preflightOrder, checkPreparedOrder } = createOrderChecker(policy, { validateOrder, buildOrderTransactions, verifyOrderAccounts });
