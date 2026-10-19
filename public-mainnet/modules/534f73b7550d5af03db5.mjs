import { createHttpDownloader } from '/public-mainnet/modules/c5ea0d606b1c61e431e9.mjs';

const httpDownloader = () => ({
  install(umi) {
    umi.downloader = createHttpDownloader(umi);
  }
});

export { httpDownloader };

