import { createWeb3JsEddsa } from '/public-mainnet/modules/b417e403eb764c51f3a0.mjs';

const web3JsEddsa = () => ({
  install(umi) {
    umi.eddsa = createWeb3JsEddsa();
  }
});

export { web3JsEddsa };

