import { mergeBytes } from '/public-mainnet/modules/fb03040488907ca37b00.mjs';
import { ExpectedFixedSizeSerializerError } from '/public-mainnet/modules/4630c2c4600a2f615ce8.mjs';

/**
 * Reverses the bytes of a fixed-size serializer.
 * @category Serializers
 */
function reverseSerializer(serializer) {
  if (serializer.fixedSize === null) {
    throw new ExpectedFixedSizeSerializerError('Cannot reverse a serializer of variable size.');
  }
  return {
    ...serializer,
    serialize: value => serializer.serialize(value).reverse(),
    deserialize: (bytes, offset = 0) => {
      const fixedSize = serializer.fixedSize;
      const newBytes = mergeBytes([bytes.slice(0, offset), bytes.slice(offset, offset + fixedSize).reverse(), bytes.slice(offset + fixedSize)]);
      return serializer.deserialize(newBytes, offset);
    }
  };
}

export { reverseSerializer };

