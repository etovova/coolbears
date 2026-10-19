import { SdkError } from '/public-mainnet/modules/f5100b67237ef376291a.mjs';

/** @category Errors */
class InvalidBaseStringError extends SdkError {
  name = 'InvalidBaseStringError';
  constructor(value, base, cause) {
    const message = `Expected a string of base ${base}, got [${value}].`;
    super(message, cause);
  }
}

export { InvalidBaseStringError };

