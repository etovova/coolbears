import { numberFactory } from '/public-mainnet/modules/a408ee4c010958338576.mjs';

const i64 = (options = {}) => numberFactory({
  name: 'i64',
  size: 8,
  range: [-BigInt('0x7fffffffffffffff') - 1n, BigInt('0x7fffffffffffffff')],
  set: (view, value, le) => view.setBigInt64(0, BigInt(value), le),
  get: (view, le) => view.getBigInt64(0, le),
  options
});

export { i64 };

