import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * An implementation of the {@link EddsaInterface} that throws an error when called.
 * @category Signers and PublicKeys
 */
function createNullEddsa() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('EddsaInterface', 'eddsa');
  };
  return {
    generateKeypair: errorHandler,
    createKeypairFromSecretKey: errorHandler,
    createKeypairFromSeed: errorHandler,
    isOnCurve: errorHandler,
    findPda: errorHandler,
    sign: errorHandler,
    verify: errorHandler
  };
}

export { createNullEddsa };

