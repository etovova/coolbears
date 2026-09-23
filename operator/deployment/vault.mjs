// Local custody for exactly three deployment account keys, never the owner key.
// This module does not read files, environment/argv, RPC or a wallet. Callers
// must persist {manifest,vault} privately before retaining a signing request.
// Zeroing is best effort: JavaScript/crypto runtimes may retain internal copies.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from './plan.mjs';
import { validateCanonicalDeploymentManifest } from './intent.mjs';
import { sha256Json } from './journal.mjs';
import { createSigningRequest } from './signing.mjs';

const derive = promisify(scrypt);
const KDF = 'scrypt-N32768-r8-p1';
const CIPHER = 'aes-256-gcm';
const KIND = 'coolbears-deployment-signer-vault';
const ROLES = ['collection', 'reservedAsset', 'machine'];
const HEADER_FIELDS = ['version', 'kind', 'id', 'cluster', 'manifestSha256', 'kdf', 'cipher', 'saltBase64', 'ivBase64'];
const VAULT_FIELDS = [...HEADER_FIELDS, 'ciphertextBase64', 'tagBase64'];
const CREATE_FIELDS = ['id', 'cluster', 'blockhash', 'lastValidBlockHeight', 'machineRentLamports', 'passphrase'];
const fail = () => Object.assign(Error('Deployment signer vault could not be used.'), { code: 'DEPLOYMENT_VAULT_INVALID' });
function check(value) { if (!value) throw fail(); }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 1;
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, names) {
  check(record(value) && Reflect.ownKeys(value).length === names.length);
  const snapshot = {};
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    check(field && Object.hasOwn(field, 'value'));
    snapshot[name] = field.value;
  }
  return snapshot;
}
function phraseBytes(value) {
  check(value instanceof Uint8Array && value.byteLength >= 16 && value.byteLength <= 1024);
  return Buffer.from(value); // Never modify or retain the caller's passphrase.
}
function address(value) {
  check(typeof value === 'string' && value.length <= 44 && new PublicKey(value).toBase58() === value);
  return value;
}
function canonicalBase64(value, size) {
  check(typeof value === 'string' && value.length === Math.ceil(size / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  check(bytes.length === size && bytes.toString('base64') === value);
  return bytes;
}
function headerBytes(header) {
  return Buffer.from(JSON.stringify(Object.fromEntries([...HEADER_FIELDS].sort().map(name => [name, header[name]]))));
}
function frozen(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function manifestSnapshot(value) {
  // Bounded plain JSON only: no getters, toJSON hooks, sparse arrays, enormous
  // strings or caller mutation while KDF/canonical-plan checks are awaiting.
  let budget = 16 * 1024 * 1024, nodes = 150000;
  function visit(item, depth = 0) {
    check(depth <= 16 && --nodes >= 0 && (budget -= 8) >= 0);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { check(Number.isFinite(item)); return item; }
    if (typeof item === 'string') {
      check(item.length <= 8192 && (budget -= Buffer.byteLength(JSON.stringify(item))) >= 0);
      return item;
    }
    if (Array.isArray(item)) {
      check(item.length <= 20000 && Reflect.ownKeys(item).length === item.length + 1);
      return Array.from({ length: item.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(item, index);
        check(field && Object.hasOwn(field, 'value')); return visit(field.value, depth + 1);
      });
    }
    check(record(item));
    const keys = Reflect.ownKeys(item);
    check(keys.length <= 32);
    return Object.fromEntries(keys.map(key => {
      check(typeof key === 'string' && key.length <= 128 && (budget -= Buffer.byteLength(JSON.stringify(key)) + 3) >= 0);
      const field = Object.getOwnPropertyDescriptor(item, key);
      check(field && Object.hasOwn(field, 'value')); return [key, visit(field.value, depth + 1)];
    }));
  }
  const copy = visit(value);
  check(Buffer.byteLength(JSON.stringify(copy)) <= 16 * 1024 * 1024);
  return copy;
}
function seedAddress(seed) {
  // Own the backing secret buffer so it can be zeroed. Keypair.secretKey's
  // public getter returns a copy in the pinned SDK and cannot clear its key.
  const secret = Buffer.alloc(64);
  try {
    const publicKey = ed25519.getPublicKey(seed);
    secret.set(seed); secret.set(publicKey, 32);
    const keypair = new Keypair({ publicKey, secretKey: secret });
    return keypair.publicKey.toBase58();
  } finally { secret.fill(0); }
}
function roleAddresses(seeds) {
  check(seeds.length === 96);
  return Object.fromEntries(ROLES.map((role, index) => [role, seedAddress(seeds.subarray(index * 32, index * 32 + 32))]));
}
function checkRoles(roles, manifest, plan) {
  check(manifest.owner === policy.owner && new Set([manifest.owner, ...Object.values(roles)]).size === 4);
  for (const role of ROLES) check(plan.roles[role] === roles[role]);
  const allowed = new Set([manifest.owner, ...Object.values(roles)]);
  for (const step of manifest.steps) {
    check(step.requiredSigners[0] === manifest.owner && step.requiredSigners.every(signer => allowed.has(signer)));
  }
}
async function encryptionKey(passphrase, salt) {
  // These resource parameters are constants, never values taken from a vault.
  return derive(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function checkedEnvelope(value, manifest) {
  const vault = exact(value, VAULT_FIELDS);
  check(vault.version === 1 && vault.kind === KIND && vault.kdf === KDF && vault.cipher === CIPHER
    && validId(vault.id) && ['devnet', 'mainnet-beta'].includes(vault.cluster)
    && typeof vault.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(vault.manifestSha256));
  canonicalBase64(vault.saltBase64, 32); canonicalBase64(vault.ivBase64, 12);
  canonicalBase64(vault.ciphertextBase64, 96); canonicalBase64(vault.tagBase64, 16);
  check(vault.id === manifest.id && vault.cluster === manifest.cluster && vault.manifestSha256 === sha256Json(manifest));
  return frozen(vault);
}

// For private storage: syntax and manifest binding only. This does not decrypt,
// authenticate a password/tag, verify key roles, or validate canonical policy.
export function validateDeploymentVaultEnvelope(vault, manifest) {
  try { return checkedEnvelope(vault, manifestSnapshot(manifest)); }
  catch { throw fail(); }
}

export async function createDeploymentSignerVault(input) {
  let passphrase, seeds, key;
  try {
    const args = exact(input, CREATE_FIELDS);
    passphrase = phraseBytes(args.passphrase);
    check(validId(args.id) && ['devnet', 'mainnet-beta'].includes(args.cluster));
    address(args.blockhash);
    check(integer(args.lastValidBlockHeight) && typeof args.machineRentLamports === 'string'
      && /^[1-9][0-9]{0,19}$/.test(args.machineRentLamports) && BigInt(args.machineRentLamports) <= (1n << 64n) - 1n);
    seeds = randomBytes(96);
    const roles = roleAddresses(seeds);
    check(new Set([policy.owner, ...Object.values(roles)]).size === 4);
    const plan = await buildDeploymentPlan({ cluster: args.cluster, ...roles, blockhash: args.blockhash,
      lastValidBlockHeight: args.lastValidBlockHeight, machineRentLamports: args.machineRentLamports });
    const manifest = deploymentManifestFromPlan(args.id, plan);
    checkRoles(roles, manifest, plan);
    const salt = randomBytes(32), iv = randomBytes(12);
    const header = { version: 1, kind: KIND, id: args.id, cluster: args.cluster,
      manifestSha256: sha256Json(manifest), kdf: KDF, cipher: CIPHER,
      saltBase64: salt.toString('base64'), ivBase64: iv.toString('base64') };
    key = await encryptionKey(passphrase, salt);
    const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: 16 });
    cipher.setAAD(headerBytes(header));
    const ciphertext = Buffer.concat([cipher.update(seeds), cipher.final()]);
    check(ciphertext.length === 96);
    return frozen({ manifest, vault: { ...header, ciphertextBase64: ciphertext.toString('base64'), tagBase64: cipher.getAuthTag().toString('base64') } });
  } catch { throw fail(); }
  finally { passphrase?.fill(0); seeds?.fill(0); key?.fill(0); }
}

function unsignedTransaction(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 1644);
  const bytes = Buffer.from(value, 'base64');
  check(bytes.length > 0 && bytes.length <= 1232 && bytes.toString('base64') === value);
  const transaction = VersionedTransaction.deserialize(bytes);
  check(Buffer.from(transaction.serialize()).equals(bytes) && transaction.version === 0
    && transaction.message.addressTableLookups.length === 0
    && transaction.signatures.every(signature => signature.length === 64 && signature.every(byte => byte === 0)));
  return transaction;
}
function signingHandle(manifest, roles, decryptedSeeds) {
  let seeds = decryptedSeeds;
  const steps = new Map(manifest.steps.map(step => [step.id, step]));
  const byAddress = new Map(ROLES.map((role, index) => [roles[role], index]));
  return Object.freeze({
    partialSign(input) {
      try {
        check(seeds !== null);
        const args = exact(input, ['stepId', 'transactionBase64', 'lastValidBlockHeight', 'attempt']);
        check(validId(args.stepId) && integer(args.lastValidBlockHeight) && integer(args.attempt));
        const step = steps.get(args.stepId); check(step);
        const transaction = unsignedTransaction(args.transactionBase64);
        const template = unsignedTransaction(step.transactionBase64);
        const blockhash = address(transaction.message.recentBlockhash);
        transaction.message.recentBlockhash = template.message.recentBlockhash;
        check(Buffer.from(transaction.message.serialize()).equals(Buffer.from(template.message.serialize())));
        transaction.message.recentBlockhash = blockhash;
        const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures).map(key => key.toBase58());
        check(signers[0] === manifest.owner && manifest.owner === policy.owner && signers.length === step.requiredSigners.length
          && signers.every((value, index) => value === step.requiredSigners[index]));
        const message = transaction.message.serialize();
        for (let index = 1; index < signers.length; index++) {
          const seedIndex = byAddress.get(signers[index]); check(seedIndex !== undefined);
          transaction.signatures[index] = ed25519.sign(message, seeds.subarray(seedIndex * 32, seedIndex * 32 + 32));
        }
        return createSigningRequest({ deploymentId: manifest.id, stepId: args.stepId, attempt: args.attempt,
          cluster: manifest.cluster, owner: manifest.owner, transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
          lastValidBlockHeight: args.lastValidBlockHeight });
      } catch { throw fail(); }
    },
    dispose() { if (seeds) seeds.fill(0); seeds = null; },
  });
}

export async function openDeploymentSignerVault(input) {
  let passphrase, key, chunk, tail, seeds, handedOff = false;
  try {
    const args = exact(input, ['vault', 'manifest', 'passphrase']);
    passphrase = phraseBytes(args.passphrase);
    const manifest = frozen(manifestSnapshot(args.manifest));
    const vault = checkedEnvelope(args.vault, manifest);
    const salt = canonicalBase64(vault.saltBase64, 32), iv = canonicalBase64(vault.ivBase64, 12);
    const ciphertext = canonicalBase64(vault.ciphertextBase64, 96), tag = canonicalBase64(vault.tagBase64, 16);
    key = await encryptionKey(passphrase, salt);
    const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: 16 });
    decipher.setAAD(headerBytes(vault)); decipher.setAuthTag(tag);
    chunk = decipher.update(ciphertext); tail = decipher.final();
    seeds = Buffer.concat([chunk, tail]); check(seeds.length === 96);
    // Authentication precedes costly canonical rebuilding; valid encryption
    // alone still does not establish policy, key-role or instruction intent.
    const roles = roleAddresses(seeds);
    check(roles.collection === manifest.steps?.[0]?.expected?.collection
      && roles.reservedAsset === manifest.steps?.[1]?.expected?.asset
      && roles.machine === manifest.steps?.[2]?.expected?.machine);
    const plan = await validateCanonicalDeploymentManifest(manifest);
    checkRoles(roles, manifest, plan);
    const handle = signingHandle(manifest, roles, seeds);
    handedOff = true;
    return handle;
  } catch { throw fail(); }
  finally {
    passphrase?.fill(0); key?.fill(0); chunk?.fill(0); tail?.fill(0);
    if (!handedOff) seeds?.fill(0);
  }
}
