import { createFetchHttp } from '/public-mainnet/modules/631ed004c1e8689f17fb.mjs';

const fetchHttp = () => ({
  install(umi) {
    umi.http = createFetchHttp();
  }
});

export { fetchHttp };

