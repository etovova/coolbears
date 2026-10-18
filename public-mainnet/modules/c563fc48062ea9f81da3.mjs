import { publicKey } from '/public-mainnet/modules/e5cce2dfd3e0f746cf59.mjs';
import { UnexpectedAccountError } from '/public-mainnet/modules/93a7cb3876aba44cd4a7.mjs';
import { AccountNotFoundError } from '/public-mainnet/modules/5ef93d0209bc04b45a98.mjs';

/**
 * The size of an account header in bytes.
 * @category Accounts
 */
const ACCOUNT_HEADER_SIZE = 128;

/**
 * Describes the header of an account.
 * @category Accounts
 */

/**
 * Given an account data serializer,
 * returns a deserialized account from a raw account.
 * @category Accounts
 */
function deserializeAccount(rawAccount, dataSerializer) {
  const {
    data,
    publicKey,
    ...rest
  } = rawAccount;
  try {
    const [parsedData] = dataSerializer.deserialize(data);
    return {
      publicKey,
      header: rest,
      ...parsedData
    };
  } catch (error) {
    throw new UnexpectedAccountError(publicKey, dataSerializer.description, error);
  }
}

/**
 * Ensures an account that may or may not exist actually exists.
 * @category Accounts
 */
function assertAccountExists(account, name, solution) {
  if (!account.exists) {
    throw new AccountNotFoundError(account.publicKey, name, solution);
  }
}

/**
 * Defines the input for a single account to be fetched and deserialized
 * as part of a mixed-account batch fetch.
 *
 * The `deserialize` callback must return an {@link Account} (i.e. an object
 * augmented with `publicKey` and `header`), matching the shape produced by
 * the kinobi-generated `deserializeX` helpers.
 *
 * @typeParam T - The deserialized account type.
 * @category Accounts
 */

/**
 * Fetches multiple accounts of potentially different types in a single RPC
 * call and deserializes each one using its provided deserializer.
 *
 * This is useful when you need to fetch accounts of different types (possibly
 * from different programs) in a single batch. Compared to calling
 * `rpc.getAccounts` directly, the result is a typed tuple where each position
 * is the deserialized type returned by its corresponding deserializer — there
 * is no manual narrowing.
 *
 * The underlying RPC `getMultipleAccounts` call has a limit of 100 accounts
 * per request. This helper does not perform client-side chunking itself, but
 * the Umi bundle defaults (and the `@metaplex-foundation/umi-rpc-chunk-get-accounts`
 * plugin) will transparently chunk requests over that limit; callers only
 * need to apply their own chunking when they want explicit control over
 * concurrency.
 *
 * All accounts must exist, otherwise an error is thrown. Use
 * {@link safeFetchAllMixedAccounts} if some accounts may not exist.
 *
 * @example
 * ```ts
 * const [metadata, edition] = await fetchAllMixedAccounts(context, [
 *   { publicKey: metadataAddr, deserialize: deserializeMetadata },
 *   { publicKey: editionAddr, deserialize: deserializeEdition },
 * ]);
 * // metadata: Metadata, edition: Edition — fully typed!
 * ```
 *
 * @category Accounts
 */
async function fetchAllMixedAccounts(context, inputs, options) {
  const publicKeys = inputs.map(input => publicKey(input.publicKey, false));
  const maybeAccounts = await context.rpc.getAccounts(publicKeys, options);
  return maybeAccounts.map((maybeAccount, index) => {
    assertAccountExists(maybeAccount);
    return inputs[index].deserialize(maybeAccount);
  });
}

/**
 * Fetches multiple accounts of potentially different types in a single RPC
 * call and deserializes each one using its provided deserializer.
 *
 * Accounts that do not exist are returned as `null` at the corresponding
 * position in the output tuple. This differs from the kinobi-generated
 * `safeFetchAllX` helpers, which *filter out* missing accounts and return a
 * dense array: positional `null`s are required here so the result tuple can
 * preserve its declared per-element types.
 *
 * @example
 * ```ts
 * const [metadata, edition] = await safeFetchAllMixedAccounts(context, [
 *   { publicKey: metadataAddr, deserialize: deserializeMetadata },
 *   { publicKey: editionAddr, deserialize: deserializeEdition },
 * ]);
 * // metadata: Metadata | null, edition: Edition | null
 * ```
 *
 * @category Accounts
 */
async function safeFetchAllMixedAccounts(context, inputs, options) {
  const publicKeys = inputs.map(input => publicKey(input.publicKey, false));
  const maybeAccounts = await context.rpc.getAccounts(publicKeys, options);
  return maybeAccounts.map((maybeAccount, index) => {
    if (!maybeAccount.exists) return null;
    return inputs[index].deserialize(maybeAccount);
  });
}

export { ACCOUNT_HEADER_SIZE, assertAccountExists, deserializeAccount, fetchAllMixedAccounts, safeFetchAllMixedAccounts };

