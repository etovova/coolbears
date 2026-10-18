import { UmiError } from '/public-mainnet/modules/75e5fa2f42030c6c9430.mjs';

/** @category Errors */
class SdkError extends UmiError {
  name = 'SdkError';
  constructor(message, cause) {
    super(message, 'sdk', undefined, cause);
  }
}

export { SdkError };

