import { InterfaceImplementationMissingError } from '/public-mainnet/modules/2c60febacfe39c948795.mjs';

/**
 * An implementation of the {@link DownloaderInterface} that throws an error when called.
 * @category Storage
 */
function createNullDownloader() {
  const errorHandler = () => {
    throw new InterfaceImplementationMissingError('DownloaderInterface', 'downloader');
  };
  return {
    download: errorHandler,
    downloadJson: errorHandler
  };
}

export { createNullDownloader };

