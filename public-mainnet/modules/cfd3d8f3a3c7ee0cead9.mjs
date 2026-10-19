import { createNullContext } from '/public-mainnet/modules/e430935af7f60d3f4c99.mjs';

/**
 * @deprecated You probably want to use `createUmi` from
 * `@metaplex-foundation/umi-bundle-defaults` instead. If
 * you're sure you want to use the base Umi without any plugins,
 * you can use `createBaseUmi` instead.
 *
 * @example Using defaults bundle:
 * import { createUmi } from '/public-mainnet/modules/58e6f85edd72b4718d18.mjs';
 * const umi = createUmi('https://...');
 *
 * @example Base only (no plugins):
 * import { createBaseUmi } from '/public-mainnet/modules/f00551e78105664b932a.mjs';
 * const umi = createBaseUmi();
 */
const createUmi = () => createBaseUmi();

/**
 * Creates a Umi instance using only Null implementations of the interfaces.
 * The `use` method can then be used to install plugins and replace the
 * Null implementations with real implementations.
 *
 * @category Context and Interfaces
 */
const createBaseUmi = () => ({
  ...createNullContext(),
  use(plugin) {
    plugin.install(this);
    return this;
  }
});

export { createBaseUmi, createUmi };

