import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const u32 = (options = {}) => numberFactory({
  name: 'u32',
  size: 4,
  range: [0, Number('0xffffffff')],
  set: (view, value, le) => view.setUint32(0, Number(value), le),
  get: (view, le) => view.getUint32(0, le),
  options
});

export { u32 };

