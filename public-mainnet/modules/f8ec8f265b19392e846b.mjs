import { createChunkGetAccountsRpc } from '/public-mainnet/modules/031da3fecfd32c4db9f4.mjs';

const chunkGetAccountsRpc = (chunkSize = 100) => ({
  install(umi) {
    umi.rpc = createChunkGetAccountsRpc(umi.rpc, chunkSize);
  }
});

export { chunkGetAccountsRpc };

