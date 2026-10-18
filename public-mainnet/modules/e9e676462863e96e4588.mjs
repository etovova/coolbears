import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const u16 = (options = {}) => numberFactory({
  name: 'u16',
  size: 2,
  range: [0, Number('0xffff')],
  set: (view, value, le) => view.setUint16(0, Number(value), le),
  get: (view, le) => view.getUint16(0, le),
  options
});

export { u16 };

