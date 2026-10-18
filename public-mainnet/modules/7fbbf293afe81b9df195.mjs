import { publicKeyBytes, publicKey as publicKey$1, PUBLIC_KEY_LENGTH } from '/public-mainnet/modules/e5cce2dfd3e0f746cf59.mjs';
import { DeserializingEmptyBufferError, NotEnoughBytesError } from '/public-mainnet/modules/38fcfb4e7f1fb4c9297f.mjs';

/**
 * Defines the options for `PublicKey` serializers.
 * @category Serializers
 */

/**
 * Creates a serializer for base58 encoded public keys.
 *
 * @param options - A set of options for the serializer.
 * @category Serializers
 */
function publicKey(options = {}) {
  return {
    description: options.description ?? 'publicKey',
    fixedSize: 32,
    maxSize: 32,
    serialize: value => publicKeyBytes(publicKey$1(value)),
    deserialize: (bytes, offset = 0) => {
      const pubkeyBytes = bytes.slice(offset, offset + 32);
      if (pubkeyBytes.length === 0) {
        throw new DeserializingEmptyBufferError('publicKey');
      }
      if (pubkeyBytes.length < PUBLIC_KEY_LENGTH) {
        throw new NotEnoughBytesError('publicKey', PUBLIC_KEY_LENGTH, pubkeyBytes.length);
      }
      return [publicKey$1(pubkeyBytes), offset + 32];
    }
  };
}

export { publicKey };

