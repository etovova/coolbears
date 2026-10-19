// Node entry point preserves the existing order policy and planning API.
import { itemsToPlan, validateOrder } from './journal.mjs';
import { createOrderPlanner } from './transaction-model.mjs';
export const { buildOrderTransactions, buildOrderItemTemplate } = createOrderPlanner({ itemsToPlan, validateOrder });
