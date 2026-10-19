import { chunk } from '/public-mainnet/modules/f00551e78105664b932a.mjs';

const createChunkGetAccountsRpc = (rpc, chunkSize = 100) => ({
  ...rpc,
  getAccounts: async (publicKeys, options) => {
    const promises = chunk(publicKeys, chunkSize).map(chunk => rpc.getAccounts(chunk, options));
    const chunks = await Promise.all(promises);
    return chunks.flat();
  }
});

export { createChunkGetAccountsRpc };

