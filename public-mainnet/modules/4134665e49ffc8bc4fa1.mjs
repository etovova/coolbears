import { fixBytes } from '/public-mainnet/modules/fb03040488907ca37b00.mjs';
import { NotEnoughBytesError } from '/public-mainnet/modules/4630c2c4600a2f615ce8.mjs';

/**
 * Creates a fixed-size serializer from a given serializer.
 *
 * @param serializer - The serializer to wrap into a fixed-size serializer.
 * @param fixedBytes - The fixed number of bytes to read.
 * @param description - A custom description for the serializer.
 *
 * @category Serializers
 */
function fixSerializer(serializer, fixedBytes, description) {
  return {
    description: description ?? `fixed(${fixedBytes}, ${serializer.description})`,
    fixedSize: fixedBytes,
    maxSize: fixedBytes,
    serialize: value => fixBytes(serializer.serialize(value), fixedBytes),
    deserialize: (buffer, offset = 0) => {
      // Slice the buffer to the fixed size.
      buffer = buffer.slice(offset, offset + fixedBytes);
      // Ensure we have enough bytes.
      if (buffer.length < fixedBytes) {
        throw new NotEnoughBytesError('fixSerializer', fixedBytes, buffer.length);
      }
      // If the nested serializer is fixed-size, pad and truncate the buffer accordingly.
      if (serializer.fixedSize !== null) {
        buffer = fixBytes(buffer, serializer.fixedSize);
      }
      // Deserialize the value using the nested serializer.
      const [value] = serializer.deserialize(buffer, 0);
      return [value, offset + fixedBytes];
    }
  };
}

export { fixSerializer };

