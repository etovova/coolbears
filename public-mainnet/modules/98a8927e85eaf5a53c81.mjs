import { ExpectedFixedSizeSerializerError, DeserializingEmptyBufferError } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';
import { u8 } from '/public-mainnet/modules/07fcf0b61aa51485486a.mjs';

/**
 * Defines the options for boolean serializers.
 * @category Serializers
 */

/**
 * Creates a boolean serializer.
 *
 * @param options - A set of options for the serializer.
 * @category Serializers
 */
function bool(options = {}) {
  const size = options.size ?? u8();
  if (size.fixedSize === null) {
    throw new ExpectedFixedSizeSerializerError('Serializer [bool] requires a fixed size.');
  }
  return {
    description: options.description ?? `bool(${size.description})`,
    fixedSize: size.fixedSize,
    maxSize: size.fixedSize,
    serialize: value => size.serialize(value ? 1 : 0),
    deserialize: (bytes, offset = 0) => {
      if (bytes.slice(offset).length === 0) {
        throw new DeserializingEmptyBufferError('bool');
      }
      const [value, vOffset] = size.deserialize(bytes, offset);
      return [value === 1, vOffset];
    }
  };
}

export { bool };

