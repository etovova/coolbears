import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * An implementation of the {@link TransactionFactoryInterface} that throws an error when called.
 * @category Transactions
 */
function createNullTransactionFactory() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('TransactionFactoryInterface', 'transactions');
  };
  return {
    create: errorHandler,
    serialize: errorHandler,
    deserialize: errorHandler,
    serializeMessage: errorHandler,
    deserializeMessage: errorHandler,
    getDefaultVersion: errorHandler
  };
}

export { createNullTransactionFactory };

