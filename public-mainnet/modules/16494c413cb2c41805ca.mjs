// Pure, shared network identity. No endpoint or cluster is selected from a request.
// Full genesis hashes: Solana ClusterType::get_genesis_hash:
// https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs
// Wallet chains: https://github.com/anza-xyz/wallet-standard/tree/master/packages/chains
// RPC roots: https://www.helius.dev/docs/api-reference/endpoints
export const GENESIS_HASHES = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
const PROFILES = Object.freeze({
  devnet: Object.freeze({ cluster: 'devnet', walletChain: 'solana:devnet',
    genesisHash: GENESIS_HASHES.devnet, rpcUpstream: 'https://devnet.helius-rpc.com/' }),
  'mainnet-beta': Object.freeze({ cluster: 'mainnet-beta', walletChain: 'solana:mainnet',
    genesisHash: GENESIS_HASHES['mainnet-beta'], rpcUpstream: 'https://mainnet.helius-rpc.com/' }),
});
export function networkProfile(cluster) {
  if (typeof cluster !== 'string' || !Object.hasOwn(PROFILES, cluster)) {
    const error = new Error('Unsupported deployment network.');
    error.code = 'DEPLOYMENT_NETWORK_INVALID';
    throw error;
  }
  return PROFILES[cluster];
}
export function networkSendAuthorized(cluster, { authorizeDevnetSend = false, authorizeMainnetSend = false } = {}) {
  networkProfile(cluster);
  if (typeof authorizeDevnetSend !== 'boolean' || typeof authorizeMainnetSend !== 'boolean') return false;
  return cluster === 'devnet' ? authorizeDevnetSend && !authorizeMainnetSend
    : authorizeMainnetSend && !authorizeDevnetSend;
}
