import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * An implementation of the {@link HttpInterface} that throws an error when called.
 * @category Http
 */
function createNullHttp() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('HttpInterface', 'http');
  };
  return {
    send: errorHandler
  };
}

export { createNullHttp };

