// Shared runtime validator. Contains no CLI, filesystem, manifest builder or secrets.
import { createHash } from 'node:crypto';
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { ed25519 } from '@noble/curves/ed25519';
import { DeploymentRpcError } from './rpc.mjs';
export const PROGRAMS = ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J', 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ'];
const ZERO_HASH = '11111111111111111111111111111111';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys, required = keys) => object(value)
  && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const need = (value, code = 'PARAMS') => { if (!value) throw new DeploymentRpcError(code); };
const address = value => {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; }
};
export const validRecoverySignature = value => {
  try { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)
    && base58.serialize(value).length === 64; } catch { return false; }
};
function decode(value, maximum) {
  need(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maximum / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  need(bytes.length <= maximum && bytes.toString('base64') === value);
  return bytes;
}
export function messageIdentity(bytes) {
  const message = VersionedMessage.deserialize(bytes);
  need(message.version === 0 && message.addressTableLookups.length === 0
    && Buffer.from(message.serialize()).equals(bytes));
  // Only the blockhash may differ from the approved template. No instruction,
  // amount, account, signer, compute setting or lookup table is normalized.
  message.recentBlockhash = ZERO_HASH;
  return createHash('sha256').update(message.serialize()).digest('hex');
}
function config(value, commitment, encoding = false) {
  return exact(value, ['commitment', 'minContextSlot', ...(encoding ? ['encoding'] : [])],
    ['commitment', ...(encoding ? ['encoding'] : [])]) && value.commitment === commitment
    && (!encoding || value.encoding === 'base64')
    && (!Object.hasOwn(value, 'minContextSlot') || uint(value.minContextSlot));
}
export function jsonSnapshot(value) {
  let text;
  try {
    text = JSON.stringify(value, (_key, item) => {
      need(!['undefined', 'function', 'symbol', 'bigint'].includes(typeof item));
      need(typeof item !== 'number' || Number.isFinite(item));
      return item;
    });
    need(typeof text === 'string' && Buffer.byteLength(text) <= 8192);
    return JSON.parse(text);
  } catch { throw new DeploymentRpcError('PARAMS'); }
}

export function createRequestValidator(input) {
  let policy;
  try { policy = JSON.parse(JSON.stringify(input)); } catch { throw new DeploymentRpcError('CONFIGURATION'); }
  need(exact(policy, ['version', 'cluster', 'owner', 'accounts', 'sizes', 'messageIdentities', 'allowSimulation', 'recoverySignatures'])
    && policy.version === 1 && policy.cluster === 'devnet' && address(policy.owner)
    && Array.isArray(policy.accounts) && policy.accounts.length === 7 && policy.accounts.every(address)
    && new Set(policy.accounts).size === 7 && PROGRAMS.every((value, index) => value === policy.accounts[index])
    && Array.isArray(policy.sizes) && policy.sizes.length > 0 && policy.sizes.length <= 10
    && policy.sizes.every(value => uint(value) && value > 0 && value <= 4 * 1024 * 1024)
    && Array.isArray(policy.messageIdentities) && policy.messageIdentities.length === 1431
    && policy.messageIdentities.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
    && new Set(policy.messageIdentities).size === 1431 && typeof policy.allowSimulation === 'boolean'
    && Array.isArray(policy.recoverySignatures) && policy.recoverySignatures.length <= 20000
    && policy.recoverySignatures.every(validRecoverySignature), 'CONFIGURATION');
  const accounts = policy.accounts, sizes = new Set(policy.sizes), identities = new Set(policy.messageIdentities);
  const recovery = new Set(policy.recoverySignatures), allowSimulation = policy.allowSimulation;
  return function validate(method, params) {
    need(Array.isArray(params));
    const [first, second] = params;
    switch (method) {
      case 'getGenesisHash': need(params.length === 0); break;
      case 'getMultipleAccounts':
        need(params.length === 2 && JSON.stringify(first) === JSON.stringify(accounts) && config(second, 'finalized', true)); break;
      case 'getBalance': need(params.length === 2 && first === policy.owner && config(second, 'finalized')); break;
      case 'getLatestBlockhash': case 'getBlockHeight': need(params.length === 1 && config(first, 'confirmed')); break;
      case 'isBlockhashValid': need(params.length === 2 && address(first) && config(second, 'confirmed')); break;
      case 'getMinimumBalanceForRentExemption':
        need(params.length === 2 && sizes.has(first) && exact(second, ['commitment']) && second.commitment === 'finalized'); break;
      case 'getFeeForMessage':
        need(params.length === 2 && config(second, 'confirmed') && identities.has(messageIdentity(decode(first, 1232)))); break;
      case 'getSignatureStatuses':
        need(params.length === 2 && Array.isArray(first) && first.length === 1 && recovery.has(first[0])
          && exact(second, ['searchTransactionHistory']) && second.searchTransactionHistory === true); break;
      case 'getTransaction':
        need(params.length === 2 && recovery.has(first) && exact(second, ['commitment', 'encoding', 'maxSupportedTransactionVersion'])
          && second.commitment === 'finalized' && second.encoding === 'base64' && second.maxSupportedTransactionVersion === 0); break;
      case 'simulateTransaction': {
        need(allowSimulation, 'METHOD');
        need(params.length === 2 && exact(second, ['encoding', 'commitment', 'sigVerify', 'replaceRecentBlockhash', 'minContextSlot'])
          && second.encoding === 'base64' && second.commitment === 'confirmed' && typeof second.sigVerify === 'boolean'
          && second.replaceRecentBlockhash === false && uint(second.minContextSlot));
        const bytes = decode(first, 1232), tx = VersionedTransaction.deserialize(bytes);
        need(Buffer.from(tx.serialize()).equals(bytes) && identities.has(messageIdentity(Buffer.from(tx.message.serialize()))));
        const message = tx.message.serialize();
        need(tx.signatures.length === tx.message.header.numRequiredSignatures);
        if (!second.sigVerify) need(tx.signatures[0].every(byte => byte === 0));
        for (let i = 0; i < tx.signatures.length; i++) {
          const empty = tx.signatures[i].every(byte => byte === 0);
          need(empty ? !second.sigVerify : ed25519.verify(tx.signatures[i], message, tx.message.staticAccountKeys[i].toBytes(), { zip215: false }));
        }
        break;
      }
      default: throw new DeploymentRpcError('METHOD');
    }
  }
}
