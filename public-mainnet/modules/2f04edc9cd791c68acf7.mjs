import { publicKey } from '/public-mainnet/modules/e5cce2dfd3e0f746cf59.mjs';

/**
 * The maximum amount of bytes that can be used for a legacy or V0 transaction.
 * @category Transactions
 */
const TRANSACTION_SIZE_LIMIT = 1232;

/**
 * The maximum amount of bytes that can be used for a V1 transaction.
 * @category Transactions
 */
const TRANSACTION_V1_SIZE_LIMIT = 4096;

/**
 * The address of the Compute Budget program. Its instructions configure the
 * compute budget of legacy and V0 transactions, but are ignored by V1
 * transactions, which use {@link TransactionV1Config} instead.
 * @category Transactions
 */
const COMPUTE_BUDGET_PROGRAM_ID = publicKey('ComputeBudget111111111111111111111111111111');

/**
 * The version of a transaction.
 * - Legacy is the very first iteration of Solana transactions.
 * - V0 introduces the concept of versioned transaction for
 * the first time and adds supports for address lookup tables.
 * - V1 raises the size limit to 4096 bytes and moves the compute
 * budget into the message itself (see {@link TransactionV1Config})
 * but does not support address lookup tables. See SIMD-0385.
 *
 * @category Transactions
 */

/**
 * Adds a given signature to the transaction's signature array
 * and returns the updated transaction as a new object.
 *
 * @category Transactions
 */
const addTransactionSignature = (transaction, signature, signerPublicKey) => {
  const maxSigners = transaction.message.header.numRequiredSignatures;
  const signerPublicKeys = transaction.message.accounts.slice(0, maxSigners);
  const signerIndex = signerPublicKeys.findIndex(key => key === signerPublicKey);
  if (signerIndex < 0) {
    throw new Error('The provided signer is not required to sign this transaction.');
  }
  const newSignatures = [...transaction.signatures];
  newSignatures[signerIndex] = signature;
  return {
    ...transaction,
    signatures: newSignatures
  };
};

export { COMPUTE_BUDGET_PROGRAM_ID, TRANSACTION_SIZE_LIMIT, TRANSACTION_V1_SIZE_LIMIT, addTransactionSignature };

