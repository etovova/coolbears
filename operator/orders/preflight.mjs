// Node adapter preserves existing CLI imports and operator policy.
import { policy } from '../prepare.mjs';
import { createOrderModel } from './journal-model.mjs';
import { createOrderPlanner } from './transaction-model.mjs';
import { createAccountVerifier } from '../deployment/accounts-model.mjs';
import { createOrderChecker } from './preflight-model.mjs';
export function createOrderPreflight(storageOptions={}) {
  const model=createOrderModel(policy,storageOptions),planner=createOrderPlanner(model);
  return createOrderChecker(policy,{...model,...planner,...createAccountVerifier(policy,storageOptions)},storageOptions);
}
export const { preflightOrder, checkPreparedOrder, checkSignedOrder } = createOrderPreflight();
