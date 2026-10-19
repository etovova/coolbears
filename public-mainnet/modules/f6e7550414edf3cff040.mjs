import { createWeb3JsRpc } from '/public-mainnet/modules/fb0e946709fd164d0cf1.mjs';

function web3JsRpc(endpointOrConnection, rpcOptions) {
  return {
    install(umi) {
      umi.rpc = typeof endpointOrConnection === 'string' ? createWeb3JsRpc(umi, endpointOrConnection, rpcOptions) : createWeb3JsRpc(umi, endpointOrConnection);
    }
  };
}

export { web3JsRpc };

