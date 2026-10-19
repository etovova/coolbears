import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * An implementation of the {@link UploaderInterface} that throws an error when called.
 * @category Storage
 */
function createNullUploader() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('UploaderInterface', 'uploader');
  };
  return {
    upload: errorHandler,
    uploadJson: errorHandler,
    getUploadPrice: errorHandler
  };
}

export { createNullUploader };

