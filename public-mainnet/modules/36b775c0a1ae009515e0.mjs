import { createWeb3JsTransactionFactory } from '/public-mainnet/modules/4da027cf6d756050790a.mjs';

const web3JsTransactionFactory = (options = {}) => ({
  install(umi) {
    umi.transactions = createWeb3JsTransactionFactory(options);
  }
});

export { web3JsTransactionFactory };

