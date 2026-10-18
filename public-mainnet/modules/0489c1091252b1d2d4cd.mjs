import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const u8 = (options = {}) => numberFactory({
  name: 'u8',
  size: 1,
  range: [0, Number('0xff')],
  set: (view, value) => view.setUint8(0, Number(value)),
  get: view => view.getUint8(0),
  options
});

export { u8 };

