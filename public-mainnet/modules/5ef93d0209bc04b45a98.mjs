import { SdkError } from '/public-mainnet/modules/f5100b67237ef376291a.mjs';

/** @category Errors */
class AccountNotFoundError extends SdkError {
  name = 'AccountNotFoundError';
  constructor(publicKey, accountType, solution) {
    const message = `${accountType ? `The account of type [${accountType}] was not found` : 'No account was found'} at the provided address [${publicKey}].${solution ? ` ${solution}` : ''}`;
    super(message);
  }
}

export { AccountNotFoundError };

