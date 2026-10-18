import { createDataViewSerializer } from '/public-mainnet/modules/fe9258112e485a8da428.mjs';

const dataViewSerializer = (options = {}) => ({
  install(umi) {
    umi.serializer = createDataViewSerializer(options);
  }
});

export { dataViewSerializer };

