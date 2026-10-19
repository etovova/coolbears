import { isOption, wrapNullable, isSome, none, some } from '/public-mainnet/modules/0b33c02799a7f62151d7.mjs';
import { ExpectedFixedSizeSerializerError, mergeBytes } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';
import { u8 } from '/public-mainnet/modules/07fcf0b61aa51485486a.mjs';
import { sumSerializerSizes } from '/public-mainnet/modules/1c90e98928bd00c45016.mjs';
import { getSizeDescription } from '/public-mainnet/modules/a38f87a13c29b35eb523.mjs';

/**
 * Defines the options for `Option` serializers.
 * @category Serializers
 */

/**
 * Creates a serializer for an optional value using the {@link Option} type.
 *
 * @param item - The serializer to use for the value that may be present.
 * @param options - A set of options for the serializer.
 * @category Serializers
 */
function option(item, options = {}) {
  const prefix = options.prefix ?? u8();
  const fixed = options.fixed ?? false;
  let descriptionSuffix = `; ${getSizeDescription(prefix)}`;
  let fixedSize = item.fixedSize === 0 ? prefix.fixedSize : null;
  if (fixed) {
    if (item.fixedSize === null || prefix.fixedSize === null) {
      throw new ExpectedFixedSizeSerializerError('Fixed options can only be used with fixed-size serializers');
    }
    descriptionSuffix += '; fixed';
    fixedSize = prefix.fixedSize + item.fixedSize;
  }
  return {
    description: options.description ?? `option(${item.description + descriptionSuffix})`,
    fixedSize,
    maxSize: sumSerializerSizes([prefix.maxSize, item.maxSize]),
    serialize: optionOrNullable => {
      const option = isOption(optionOrNullable) ? optionOrNullable : wrapNullable(optionOrNullable);
      const prefixByte = prefix.serialize(Number(isSome(option)));
      if (fixed) {
        const itemFixedSize = item.fixedSize;
        const itemBytes = isSome(option) ? item.serialize(option.value).slice(0, itemFixedSize) : new Uint8Array(itemFixedSize).fill(0);
        return mergeBytes([prefixByte, itemBytes]);
      }
      const itemBytes = isSome(option) ? item.serialize(option.value) : new Uint8Array();
      return mergeBytes([prefixByte, itemBytes]);
    },
    deserialize: (bytes, offset = 0) => {
      if (bytes.slice(offset).length === 0) {
        return [none(), offset];
      }
      const fixedOffset = offset + (prefix.fixedSize ?? 0) + (item.fixedSize ?? 0);
      const [isSome, prefixOffset] = prefix.deserialize(bytes, offset);
      offset = prefixOffset;
      if (isSome === 0) {
        return [none(), fixed ? fixedOffset : offset];
      }
      const [value, newOffset] = item.deserialize(bytes, offset);
      offset = newOffset;
      return [some(value), fixed ? fixedOffset : offset];
    }
  };
}

export { option };

