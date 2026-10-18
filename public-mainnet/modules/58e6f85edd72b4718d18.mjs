import { createBaseUmi } from '/public-mainnet/modules/f00551e78105664b932a.mjs';
import { defaultPlugins } from '/public-mainnet/modules/db1ecda7a260229c5cbe.mjs';
export { defaultPlugins } from '/public-mainnet/modules/db1ecda7a260229c5cbe.mjs';

function createUmi(endpointOrConnection, rpcOptions) {
  return createBaseUmi().use(typeof endpointOrConnection === 'string' ? defaultPlugins(endpointOrConnection, rpcOptions) : defaultPlugins(endpointOrConnection, rpcOptions));
}

export { createUmi };

