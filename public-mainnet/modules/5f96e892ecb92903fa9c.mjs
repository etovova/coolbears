import { mapSerializer, struct, array, bytes, shortU16, publicKey, string, base58, u8 } from '/public-mainnet/modules/bd70ea658958e30a0826.mjs';
import { TRANSACTION_V1_PREFIX, getTransactionV1MessageSerializer, getTransactionMessageHeaderSerializer, getTransactionV1Serializer } from '/public-mainnet/modules/025676da7d85c53c45a6.mjs';
import { SdkError } from '/public-mainnet/modules/f5100b67237ef376291a.mjs';

/* eslint-disable no-bitwise */
const TRANSACTION_VERSION_FLAG = 0x80;
const TRANSACTION_VERSION_MASK = 0x7f;

/**
 * Serializes and deserializes transactions of any version.
 * Legacy and V0 transactions are a short-vec of signatures followed by
 * the message, V1 transactions are the message followed by its signatures.
 * The version is read from the first byte when deserializing.
 * @category Transactions
 */
const getTransactionSerializer = () => {
  const legacyOrV0 = getLegacyOrV0TransactionSerializer();
  const v1 = getTransactionV1Serializer();
  return {
    description: 'Transaction',
    fixedSize: null,
    maxSize: null,
    serialize: value => (value.message.version === 1 ? v1 : legacyOrV0).serialize(value),
    deserialize: (buffer, offset = 0) => (buffer[offset] === TRANSACTION_V1_PREFIX ? v1 : legacyOrV0).deserialize(buffer, offset)
  };
};

/**
 * Serializes and deserializes transaction messages of any version.
 * The version is read from the first byte when deserializing.
 * @category Transactions
 */
const getTransactionMessageSerializer = () => ({
  description: 'TransactionMessage',
  fixedSize: null,
  maxSize: null,
  serialize: value => getTransactionMessageSerializerForVersion(value.version).serialize(value),
  deserialize: (buffer, offset = 0) => {
    const [version] = getTransactionVersionSerializer().deserialize(buffer, offset);
    return getTransactionMessageSerializerForVersion(version).deserialize(buffer, offset);
  }
});

/** Legacy and V0 transactions: a short-vec of signatures then the message. */
const getLegacyOrV0TransactionSerializer = () => mapSerializer(struct([['signatures', array(bytes({
  size: 64
}), {
  size: shortU16()
})], ['serializedMessage', bytes()]]), value => value, value => ({
  ...value,
  message: getTransactionMessageSerializer().deserialize(value.serializedMessage)[0]
}));
const getTransactionMessageSerializerForVersion = version => version === 1 ? getTransactionV1MessageSerializer() : struct([['version', getTransactionVersionSerializer()], ['header', getTransactionMessageHeaderSerializer()], ['accounts', array(publicKey(), {
  size: shortU16()
})], ['blockhash', string({
  encoding: base58,
  size: 32
})], ['instructions', array(getCompiledInstructionSerializer(), {
  size: shortU16()
})], ['addressLookupTables', array(getCompiledAddressLookupTableSerializer(), {
  size: version === 'legacy' ? 0 : shortU16()
})]]);
const getTransactionVersionSerializer = () => ({
  description: 'TransactionVersion',
  fixedSize: null,
  maxSize: 1,
  serialize: value => {
    if (value === 'legacy') return new Uint8Array([]);
    return new Uint8Array([TRANSACTION_VERSION_FLAG | value]);
  },
  deserialize: (buffer, offset = 0) => {
    const slice = buffer.slice(offset);
    if (slice.length === 0 || (slice[0] & TRANSACTION_VERSION_FLAG) === 0) {
      return ['legacy', offset];
    }
    const version = slice[0] & TRANSACTION_VERSION_MASK;
    if (version > 1) {
      throw new SdkError(`Unsupported transaction version: ${version}.`);
    }
    return [version, offset + 1];
  }
});
const getCompiledInstructionSerializer = () => struct([['programIndex', u8()], ['accountIndexes', array(u8(), {
  size: shortU16()
})], ['data', bytes({
  size: shortU16()
})]]);
const getCompiledAddressLookupTableSerializer = () => struct([['publicKey', publicKey()], ['writableIndexes', array(u8(), {
  size: shortU16()
})], ['readonlyIndexes', array(u8(), {
  size: shortU16()
})]]);

export { getTransactionMessageSerializer, getTransactionSerializer };

