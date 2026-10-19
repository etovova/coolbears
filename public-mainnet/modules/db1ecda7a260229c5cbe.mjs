import { httpDownloader } from '/public-mainnet/modules/c79bc153d7d98be33fdc.mjs';
import { web3JsEddsa } from '/public-mainnet/modules/57873fa7d10a8fa2c6f0.mjs';
import { fetchHttp } from '/public-mainnet/modules/092362c9179c8c706fc7.mjs';
import { defaultProgramRepository } from '/public-mainnet/modules/a55a58e97a16bd675c10.mjs';
import { web3JsRpc } from '/public-mainnet/modules/16c4de7202c378049456.mjs';
import { chunkGetAccountsRpc } from '/public-mainnet/modules/c0aaee1adebedda01b96.mjs';
import { dataViewSerializer } from '/public-mainnet/modules/a8d1b4e9023c1b80b2cd.mjs';
import { web3JsTransactionFactory } from '/public-mainnet/modules/3b1f964cc0d35ab1ca41.mjs';

function defaultPlugins(endpointOrConnection, rpcOptions) {
  return {
    install(umi) {
      umi.use(dataViewSerializer());
      umi.use(defaultProgramRepository());
      umi.use(fetchHttp());
      umi.use(httpDownloader());
      umi.use(web3JsEddsa());
      umi.use(typeof endpointOrConnection === 'string' ? web3JsRpc(endpointOrConnection, rpcOptions) : web3JsRpc(endpointOrConnection));
      umi.use(chunkGetAccountsRpc(rpcOptions?.getAccountsChunkSize));
      umi.use(web3JsTransactionFactory());
    }
  };
}

export { defaultPlugins };

