import { struct, u8, string, base58, publicKey, u64, u32, mergeBytes, u16, array, bytes } from '/public-mainnet/modules/bd70ea658958e30a0826.mjs';
import { lamports } from '/public-mainnet/modules/7bdedf7b2bde6f4edcbe.mjs';
import { SdkError } from '/public-mainnet/modules/f5100b67237ef376291a.mjs';

/* eslint-disable no-bitwise */
/**
 * The first byte of every serialized V1 message and transaction:
 * the version flag (`0x80`) combined with the version (`1`).
 * @category Transactions
 */
const TRANSACTION_V1_PREFIX = 0x81;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;
const DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

/**
 * Asserts that a {@link TransactionV1Config} only holds values the Solana runtime
 * will honor as written for a V1 transaction, throwing a clear {@link SdkError}
 * otherwise. This mirrors the runtime's own sanitization: an out-of-range
 * compute unit limit is silently clamped, and an invalid heap size is rejected
 * by the node with an unrelated-sounding error, so failing here is friendlier.
 * @category Transactions
 */
const assertValidTransactionV1Config = config => {
  const {
    computeUnitLimit,
    heapSize
  } = config;
  if (computeUnitLimit !== undefined && (!Number.isInteger(computeUnitLimit) || computeUnitLimit < 0 || computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT)) {
    throw new SdkError(`Invalid computeUnitLimit: ${computeUnitLimit}. ` + 'Expected an integer between 0 and 1,400,000.');
  }
  if (heapSize !== undefined && (!Number.isInteger(heapSize) || heapSize < 32_768 || heapSize > 262_144 || heapSize % 1_024 !== 0)) {
    throw new SdkError(`Invalid heapSize: ${heapSize}. ` + 'Expected a multiple of 1,024 between 32,768 and 262,144.');
  }
};

/**
 * The compute budget a {@link TransactionBuilder} attaches to a V1
 * transaction when the caller does not set one. Matches what legacy
 * and V0 transactions get without ComputeBudget instructions: 200k
 * compute units per instruction, capped at 1.4M, and 64MiB of loaded
 * account data. `TransactionFactoryInterface.create` does not apply
 * these defaults.
 * @category Transactions
 */
const defaultTransactionV1Config = (instructionCount, overrides = {}) => ({
  ...overrides,
  // Nullish coalescing so that an `undefined` override keeps the default
  // while an explicit zero is preserved.
  computeUnitLimit: overrides.computeUnitLimit ?? Math.min(DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION * instructionCount, MAX_COMPUTE_UNIT_LIMIT),
  loadedAccountsDataSizeLimit: overrides.loadedAccountsDataSizeLimit ?? DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT
});
const getSignaturesSerializer = count => array(bytes({
  size: 64
}), {
  size: count
});

// A Uint8Array would silently wrap out-of-range or fractional indexes.
const assertAccountIndex = index => {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new SdkError(`Invalid account index: ${index}. Expected an integer between 0 and 255.`);
  }
  return index;
};

// The bits of the config mask of V1 messages, see SIMD-0385.
const CONFIG_PRIORITY_FEE_BITS = 0b00011;
const CONFIG_COMPUTE_UNIT_LIMIT_BIT = 0b00100;
const CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT = 0b01000;
const CONFIG_HEAP_SIZE_BIT = 0b10000;
const CONFIG_KNOWN_BITS = CONFIG_PRIORITY_FEE_BITS | CONFIG_COMPUTE_UNIT_LIMIT_BIT | CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT | CONFIG_HEAP_SIZE_BIT;

/**
 * Serializes and deserializes the header of a transaction message.
 * @category Transactions
 */
const getTransactionMessageHeaderSerializer = () => struct([['numRequiredSignatures', u8()], ['numReadonlySignedAccounts', u8()], ['numReadonlyUnsignedAccounts', u8()]]);

/**
 * Serializes and deserializes V1 transaction messages
 * using the wire format defined by SIMD-0385.
 * @category Transactions
 */
const getTransactionV1MessageSerializer = () => {
  const headerSerializer = getTransactionMessageHeaderSerializer();
  const blockhashSerializer = string({
    encoding: base58,
    size: 32
  });
  const publicKeySerializer = publicKey();
  return {
    description: 'TransactionMessageV1',
    fixedSize: null,
    maxSize: null,
    serialize: value => {
      if (value.version !== 1) {
        throw new SdkError(`Expected a V1 transaction message but got version ${value.version}.`);
      }
      if (value.addressLookupTables.length > 0) {
        throw new SdkError('V1 transaction messages do not support address lookup tables.');
      }
      const config = value.transactionConfig ?? {};
      assertValidTransactionV1Config(config);
      let configMask = 0;
      const configValues = [];
      if (config.priorityFee !== undefined) {
        configMask |= CONFIG_PRIORITY_FEE_BITS;
        configValues.push(u64().serialize(config.priorityFee.basisPoints));
      }
      if (config.computeUnitLimit !== undefined) {
        configMask |= CONFIG_COMPUTE_UNIT_LIMIT_BIT;
        configValues.push(u32().serialize(config.computeUnitLimit));
      }
      if (config.loadedAccountsDataSizeLimit !== undefined) {
        configMask |= CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT;
        configValues.push(u32().serialize(config.loadedAccountsDataSizeLimit));
      }
      if (config.heapSize !== undefined) {
        configMask |= CONFIG_HEAP_SIZE_BIT;
        configValues.push(u32().serialize(config.heapSize));
      }
      return mergeBytes([u8().serialize(TRANSACTION_V1_PREFIX), headerSerializer.serialize(value.header), u32().serialize(configMask), blockhashSerializer.serialize(value.blockhash), u8().serialize(value.instructions.length), u8().serialize(value.accounts.length), ...value.accounts.map(account => publicKeySerializer.serialize(account)), ...configValues, ...value.instructions.map(instruction => mergeBytes([u8().serialize(assertAccountIndex(instruction.programIndex)), u8().serialize(instruction.accountIndexes.length), u16().serialize(instruction.data.length)])), ...value.instructions.map(instruction => mergeBytes([new Uint8Array(instruction.accountIndexes.map(assertAccountIndex)), instruction.data]))]);
    },
    deserialize: (buffer, offset = 0) => {
      let cursor = offset;
      const read = serializer => {
        const [value, next] = serializer.deserialize(buffer, cursor);
        cursor = next;
        return value;
      };
      const prefix = read(u8());
      if (prefix !== TRANSACTION_V1_PREFIX) {
        throw new SdkError(`Expected a V1 message prefix (${TRANSACTION_V1_PREFIX}) but got ${prefix}.`);
      }
      const header = read(headerSerializer);
      const configMask = read(u32());
      if ((configMask & ~CONFIG_KNOWN_BITS) !== 0) {
        throw new SdkError('Unexpected bits set in the transaction config mask.');
      }
      const priorityFeeBits = configMask & CONFIG_PRIORITY_FEE_BITS;
      if (priorityFeeBits !== 0 && priorityFeeBits !== CONFIG_PRIORITY_FEE_BITS) {
        throw new SdkError('Expected both or neither of the priority fee bits to be set in the transaction config mask.');
      }
      const blockhash = read(blockhashSerializer);
      const numInstructions = read(u8());
      const numAccounts = read(u8());
      const accounts = read(array(publicKeySerializer, {
        size: numAccounts
      }));
      const transactionConfig = {};
      if (priorityFeeBits !== 0) {
        transactionConfig.priorityFee = lamports(read(u64()));
      }
      if (configMask & CONFIG_COMPUTE_UNIT_LIMIT_BIT) {
        transactionConfig.computeUnitLimit = read(u32());
      }
      if (configMask & CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT) {
        transactionConfig.loadedAccountsDataSizeLimit = read(u32());
      }
      if (configMask & CONFIG_HEAP_SIZE_BIT) {
        transactionConfig.heapSize = read(u32());
      }
      const instructionHeaders = Array.from({
        length: numInstructions
      }, () => ({
        programIndex: read(u8()),
        numAccountIndexes: read(u8()),
        dataLength: read(u16())
      }));
      const instructions = instructionHeaders.map(({
        programIndex,
        numAccountIndexes,
        dataLength
      }) => ({
        programIndex,
        accountIndexes: Array.from(read(bytes({
          size: numAccountIndexes
        }))),
        data: read(bytes({
          size: dataLength
        }))
      }));
      return [{
        version: 1,
        header,
        accounts,
        blockhash,
        instructions,
        addressLookupTables: [],
        transactionConfig
      }, cursor];
    }
  };
};

/**
 * Serializes and deserializes V1 transactions: the serialized message
 * followed by `numRequiredSignatures` signatures, without length prefix.
 * @category Transactions
 */
const getTransactionV1Serializer = () => ({
  description: 'TransactionV1',
  fixedSize: null,
  maxSize: null,
  serialize: value => mergeBytes([value.serializedMessage, getSignaturesSerializer(value.message.header.numRequiredSignatures).serialize(value.signatures)]),
  deserialize: (buffer, offset = 0) => {
    const [message, messageEnd] = getTransactionV1MessageSerializer().deserialize(buffer, offset);
    const [signatures, end] = getSignaturesSerializer(message.header.numRequiredSignatures).deserialize(buffer, messageEnd);
    return [{
      message,
      serializedMessage: buffer.slice(offset, messageEnd),
      signatures
    }, end];
  }
});

export { TRANSACTION_V1_PREFIX, assertValidTransactionV1Config, defaultTransactionV1Config, getTransactionMessageHeaderSerializer, getTransactionV1MessageSerializer, getTransactionV1Serializer };

