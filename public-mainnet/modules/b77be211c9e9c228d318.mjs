import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const i8 = (options = {}) => numberFactory({
  name: 'i8',
  size: 1,
  range: [-Number('0x7f') - 1, Number('0x7f')],
  set: (view, value) => view.setInt8(0, Number(value)),
  get: view => view.getInt8(0),
  options
});

export { i8 };

