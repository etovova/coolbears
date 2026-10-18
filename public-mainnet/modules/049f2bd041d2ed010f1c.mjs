import { mergeBytes } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';
import { sumSerializerSizes } from '/public-mainnet/modules/1c90e98928bd00c45016.mjs';

/**
 * Get the name and serializer of each field in a struct.
 * @category Serializers
 */

/**
 * Creates a serializer for a custom object.
 *
 * @param fields - The name and serializer of each field.
 * @param options - A set of options for the serializer.
 * @category Serializers
 */
function struct(fields, options = {}) {
  const fieldDescriptions = fields.map(([name, serializer]) => `${String(name)}: ${serializer.description}`).join(', ');
  return {
    description: options.description ?? `struct(${fieldDescriptions})`,
    fixedSize: sumSerializerSizes(fields.map(([, field]) => field.fixedSize)),
    maxSize: sumSerializerSizes(fields.map(([, field]) => field.maxSize)),
    serialize: struct => {
      const fieldBytes = fields.map(([key, serializer]) => serializer.serialize(struct[key]));
      return mergeBytes(fieldBytes);
    },
    deserialize: (bytes, offset = 0) => {
      const struct = {};
      fields.forEach(([key, serializer]) => {
        const [value, newOffset] = serializer.deserialize(bytes, offset);
        offset = newOffset;
        struct[key] = value;
      });
      return [struct, offset];
    }
  };
}

export { struct };

