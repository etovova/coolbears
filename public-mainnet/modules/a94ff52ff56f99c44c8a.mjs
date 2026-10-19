import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * Defines the interface for an RPC client.
 * It allows us to interact with the Solana blockchain.
 *
 * Implementations should submit transactions base64-encoded when
 * sending or simulating them: the RPC caps base58-encoded transactions
 * at 1232 bytes regardless of version, so larger V1 transactions are
 * only accepted over base64.
 *
 * @category Context and Interfaces
 */

/**
 * An implementation of the {@link RpcInterface} that throws an error when called.
 * @category Rpc
 */
function createNullRpc() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('RpcInterface', 'rpc');
  };
  return {
    getEndpoint: errorHandler,
    getCluster: errorHandler,
    getAccount: errorHandler,
    getAccounts: errorHandler,
    getProgramAccounts: errorHandler,
    getBlockTime: errorHandler,
    getBalance: errorHandler,
    getRent: errorHandler,
    getSlot: errorHandler,
    getGenesisHash: errorHandler,
    getLatestBlockhash: errorHandler,
    getTransaction: errorHandler,
    getSignatureStatuses: errorHandler,
    accountExists: errorHandler,
    airdrop: errorHandler,
    call: errorHandler,
    sendTransaction: errorHandler,
    simulateTransaction: errorHandler,
    confirmTransaction: errorHandler
  };
}

export { createNullRpc };

