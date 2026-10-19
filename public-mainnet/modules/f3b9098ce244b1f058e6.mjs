import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const f64 = (options = {}) => numberFactory({
  name: 'f64',
  size: 8,
  set: (view, value, le) => view.setFloat64(0, Number(value), le),
  get: (view, le) => view.getFloat64(0, le),
  options
});

export { f64 };

