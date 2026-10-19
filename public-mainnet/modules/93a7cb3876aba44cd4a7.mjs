import { SdkError } from '/public-mainnet/modules/f5100b67237ef376291a.mjs';

/** @category Errors */
class UnexpectedAccountError extends SdkError {
  name = 'UnexpectedAccountError';
  constructor(publicKey, expectedType, cause) {
    const message = `The account at the provided address [${publicKey}] ` + `is not of the expected type [${expectedType}].`;
    super(message, cause);
  }
}

export { UnexpectedAccountError };

