import { fixSerializer, mergeBytes, DeserializingEmptyBufferError, NotEnoughBytesError } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';
import { utf8 } from '/public-mainnet/modules/facd475acc3b379ec56d.mjs';
import { u32 } from '/public-mainnet/modules/07fcf0b61aa51485486a.mjs';
import { getSizeDescription } from '/public-mainnet/modules/a38f87a13c29b35eb523.mjs';

/**
 * Defines the options for string serializers.
 * @category Serializers
 */

/**
 * Creates a string serializer.
 *
 * @param options - A set of options for the serializer.
 * @category Serializers
 */
function string(options = {}) {
  const size = options.size ?? u32();
  const encoding = options.encoding ?? utf8;
  const description = options.description ?? `string(${encoding.description}; ${getSizeDescription(size)})`;
  if (size === 'variable') {
    return {
      ...encoding,
      description
    };
  }
  if (typeof size === 'number') {
    return fixSerializer(encoding, size, description);
  }
  return {
    description,
    fixedSize: null,
    maxSize: null,
    serialize: value => {
      const contentBytes = encoding.serialize(value);
      const lengthBytes = size.serialize(contentBytes.length);
      return mergeBytes([lengthBytes, contentBytes]);
    },
    deserialize: (buffer, offset = 0) => {
      if (buffer.slice(offset).length === 0) {
        throw new DeserializingEmptyBufferError('string');
      }
      const [lengthBigInt, lengthOffset] = size.deserialize(buffer, offset);
      const length = Number(lengthBigInt);
      offset = lengthOffset;
      const contentBuffer = buffer.slice(offset, offset + length);
      if (contentBuffer.length < length) {
        throw new NotEnoughBytesError('string', length, contentBuffer.length);
      }
      const [value, contentOffset] = encoding.deserialize(contentBuffer);
      offset += contentOffset;
      return [value, offset];
    }
  };
}

export { string };

