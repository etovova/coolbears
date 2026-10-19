import { getTransactionSerializer, getTransactionMessageSerializer } from '/public-mainnet/modules/f00551e78105664b932a.mjs';
import { toWeb3JsMessageFromInput, fromWeb3JsMessage } from '/public-mainnet/modules/d1a0037470c4e8895e78.mjs';
import { VersionedTransaction } from '/public-mainnet/modules/60139917f8765411c2c3.mjs';

function createWeb3JsTransactionFactory(options = {}) {
  const create = input => {
    // @solana/web3.js models the V1 compute budget with JS numbers, which
    // cannot hold a u64 priority fee. Compile the accounts without it and
    // keep the caller's exact config on the Umi message instead.
    const web3JsMessage = toWeb3JsMessageFromInput(input.version === 1 ? {
      ...input,
      transactionConfig: undefined
    } : input);
    let message = fromWeb3JsMessage(web3JsMessage);
    if (input.version === 1) {
      message = {
        ...message,
        transactionConfig: input.transactionConfig ?? {}
      };
    }
    const web3JsTransaction = new VersionedTransaction(web3JsMessage, input.signatures);
    return {
      message,
      serializedMessage: serializeMessage(message),
      signatures: web3JsTransaction.signatures
    };
  };
  const serialize = transaction => getTransactionSerializer().serialize(transaction);
  const deserialize = serializedTransaction => getTransactionSerializer().deserialize(serializedTransaction)[0];
  const serializeMessage = message => getTransactionMessageSerializer().serialize(message);
  const deserializeMessage = serializedMessage => getTransactionMessageSerializer().deserialize(serializedMessage)[0];
  return {
    create,
    serialize,
    deserialize,
    serializeMessage,
    deserializeMessage,
    getDefaultVersion: () => options.defaultTransactionVersion ?? 0
  };
}

export { createWeb3JsTransactionFactory };

