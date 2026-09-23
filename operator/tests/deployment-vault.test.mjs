// Synthetic local custody fixtures only. No production vault is created,
// persisted or sent anywhere; the approved owner's private key is never used.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { inspect } from 'node:util';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { policy } from '../prepare.mjs';
import { sha256Json } from '../deployment/journal.mjs';
import { createSigningRequest } from '../deployment/signing.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault, validateDeploymentVaultEnvelope } from '../deployment/vault.mjs';

const passphrase = Buffer.from('offline-vault-test-passphrase-32-bytes');
const publicOptions = { id: 'custody-fixture', cluster: 'devnet',
  blockhash: new PublicKey(new Uint8Array(32).fill(41)).toBase58(), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' };
const freshHash = new PublicKey(new Uint8Array(32).fill(42)).toBase58();
const headerNames = ['version', 'kind', 'id', 'cluster', 'manifestSha256', 'kdf', 'cipher', 'saltBase64', 'ivBase64'];
const aad = vault => Buffer.from(JSON.stringify(Object.fromEntries([...headerNames].sort().map(name => [name, vault[name]]))));
const copy = value => JSON.parse(JSON.stringify(value));
const decode = text => VersionedTransaction.deserialize(Buffer.from(text, 'base64'));
const encode = transaction => Buffer.from(transaction.serialize()).toString('base64');
const invalidError = error => error.code === 'DEPLOYMENT_VAULT_INVALID' && error.message === 'Deployment signer vault could not be used.';
const rejected = promise => assert.rejects(promise, invalidError);
const throws = callback => assert.throws(callback, invalidError);
let fixture, handle, fixtureSeeds, originalFetch, liveCalls = 0;

function decryptFixture(vault) {
  const key = scryptSync(passphrase, Buffer.from(vault.saltBase64, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  let chunk, tail;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.ivBase64, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(vault)); decipher.setAuthTag(Buffer.from(vault.tagBase64, 'base64'));
    chunk = decipher.update(Buffer.from(vault.ciphertextBase64, 'base64')); tail = decipher.final();
    return Buffer.concat([chunk, tail]);
  } finally { key.fill(0); chunk?.fill(0); tail?.fill(0); }
}
function reencryptFixture(seeds, manifest = fixture.manifest) {
  // An authenticated but malicious fixture tests role/intent validation after
  // successful decryption. Use a fresh IV even for this local negative fixture.
  const vault = { ...fixture.vault, manifestSha256: sha256Json(manifest), ivBase64: randomBytes(12).toString('base64') };
  const key = scryptSync(passphrase, Buffer.from(vault.saltBase64, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(vault.ivBase64, 'base64'), { authTagLength: 16 });
    cipher.setAAD(aad(vault));
    vault.ciphertextBase64 = Buffer.concat([cipher.update(seeds), cipher.final()]).toString('base64');
    vault.tagBase64 = cipher.getAuthTag().toString('base64');
    return vault;
  } finally { key.fill(0); }
}
function candidate(stepId = 'collection-create', mutate) {
  const step = fixture.manifest.steps.find(step => step.id === stepId);
  const transaction = decode(step.transactionBase64); transaction.message.recentBlockhash = freshHash;
  mutate?.(transaction);
  return { stepId, transactionBase64: encode(transaction), lastValidBlockHeight: 2000, attempt: 1 };
}
function flipBase64(value) { const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); }

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { liveCalls++; throw Error('Live network forbidden'); };
  fixture = await createDeploymentSignerVault({ ...publicOptions, passphrase });
  fixtureSeeds = decryptFixture(fixture.vault);
  handle = await openDeploymentSignerVault({ ...fixture, passphrase });
});
after(() => { handle?.dispose(); fixtureSeeds?.fill(0); globalThis.fetch = originalFetch; assert.equal(liveCalls, 0); });

test('vault encrypts exactly three role seeds with fixed KDF and authenticated canonical manifest header', () => {
  assert.equal(fixture.vault.version, 1); assert.equal(fixture.vault.kind, 'coolbears-deployment-signer-vault');
  assert.equal(fixture.vault.kdf, 'scrypt-N32768-r8-p1'); assert.equal(fixture.vault.cipher, 'aes-256-gcm');
  assert.equal(fixture.vault.manifestSha256, sha256Json(fixture.manifest));
  assert.equal(fixture.manifest.owner, policy.owner); assert.equal(fixture.manifest.steps.length, 1431);
  for (const [field, size] of [['saltBase64', 32], ['ivBase64', 12], ['ciphertextBase64', 96], ['tagBase64', 16]]) {
    assert.equal(Buffer.from(fixture.vault[field], 'base64').length, size);
  }
  assert.equal(fixtureSeeds.length, 96);
  const derived = [0, 1, 2].map(index => new PublicKey(ed25519.getPublicKey(fixtureSeeds.subarray(index * 32, index * 32 + 32))).toBase58());
  assert.deepEqual(derived, [fixture.manifest.steps[0].expected.collection, fixture.manifest.steps[1].expected.asset, fixture.manifest.steps[2].expected.machine]);
  assert.equal(new Set([...derived, policy.owner]).size, 4);
  assert.ok(Object.isFrozen(fixture) && Object.isFrozen(fixture.vault) && Object.isFrozen(fixture.manifest.steps));
  assert.deepEqual(Object.keys(fixture).sort(), ['manifest', 'vault']);
});

test('fresh vault creation uses independent account keys, salt and IV without changing caller passphrase', async () => {
  const before = Buffer.from(passphrase);
  const another = await createDeploymentSignerVault({ ...publicOptions, passphrase });
  for (const field of ['saltBase64', 'ivBase64', 'ciphertextBase64']) assert.notEqual(another.vault[field], fixture.vault[field]);
  for (const index of [0, 1, 2]) assert.notEqual(another.manifest.steps[index].requiredSigners[1], fixture.manifest.steps[index].requiredSigners[1]);
  assert.deepEqual(passphrase, before);
});

test('partial signing covers collection, reserved asset, machine and owner-only insertion without signing owner', () => {
  for (const stepId of ['collection-create', 'reserve-create', 'machine-create', fixture.manifest.steps[3].id]) {
    const input = candidate(stepId); const request = handle.partialSign(input);
    const transaction = decode(request.transactionBase64), original = decode(input.transactionBase64);
    assert.equal(request.deploymentId, fixture.manifest.id); assert.equal(request.owner, policy.owner);
    assert.equal(request.blockhash, freshHash); assert.equal(request.lastValidBlockHeight, 2000); assert.equal(request.attempt, 1);
    assert.deepEqual(transaction.message.serialize(), original.message.serialize());
    assert.ok(transaction.signatures[0].every(byte => byte === 0));
    for (let index = 1; index < transaction.signatures.length; index++) {
      assert.ok(ed25519.verify(transaction.signatures[index], transaction.message.serialize(), transaction.message.staticAccountKeys[index].toBytes(), { zip215: false }));
    }
    const { version, kind, blockhash, messageSha256, requiredSigners, ...requestInput } = request;
    assert.deepEqual(createSigningRequest(requestInput), request);
    assert.equal(request.requiredSigners.length, stepId.startsWith('insert-') ? 1 : 2);
  }
});

test('JSON reload preserves role addresses and produces the same deterministic partial signature', async () => {
  const reloaded = copy(fixture); const reopened = await openDeploymentSignerVault({ ...reloaded, passphrase });
  try {
    assert.deepEqual(reopened.partialSign(candidate()), handle.partialSign(candidate()));
    assert.deepEqual(reloaded, fixture);
    assert.deepEqual(Object.keys(reopened).sort(), ['dispose', 'partialSign']);
    assert.ok(Object.isFrozen(reopened)); assert.equal(JSON.stringify(reopened), '{}');
    const printable = inspect(reopened);
    assert.equal(printable.includes(passphrase.toString()), false); assert.equal(printable.includes(fixtureSeeds.toString('hex')), false);
    assert.equal('secretKey' in reopened, false); assert.equal('ownerKey' in reopened, false);
  } finally { reopened.dispose(); }
});

test('envelope validation is strict, cheap and returns a clone without claiming password authentication', () => {
  const cloned = validateDeploymentVaultEnvelope(fixture.vault, fixture.manifest);
  assert.deepEqual(cloned, fixture.vault); assert.notEqual(cloned, fixture.vault); assert.ok(Object.isFrozen(cloned));
  const tagChanged = { ...fixture.vault, tagBase64: flipBase64(fixture.vault.tagBase64) };
  assert.deepEqual(validateDeploymentVaultEnvelope(tagChanged, fixture.manifest), tagChanged);
  for (const changes of [{ version: 2 }, { kind: 'other' }, { kdf: 'scrypt-N999999999-r8-p1' },
    { cipher: 'aes-256-cbc' }, { N: 999999999 }, { ciphertextBase64: 'A'.repeat(100000) },
    { saltBase64: `${fixture.vault.saltBase64}\n` }, { tagBase64: `${fixture.vault.tagBase64}=` },
    { manifestSha256: 'a'.repeat(64) }, { id: '../secret' }, { cluster: 'testnet' }]) {
    throws(() => validateDeploymentVaultEnvelope({ ...fixture.vault, ...changes }, fixture.manifest));
  }
  const sparse = copy(fixture.manifest); sparse.steps = new Array(1431);
  throws(() => validateDeploymentVaultEnvelope(fixture.vault, sparse));
  const getter = { ...fixture.vault };
  Object.defineProperty(getter, 'kdf', { enumerable: true, get() { throw Error('secret-provider-text'); } });
  throws(() => validateDeploymentVaultEnvelope(getter, fixture.manifest));
});

test('wrong passphrase and altered authenticated header, ciphertext or tag cannot open', async () => {
  await rejected(openDeploymentSignerVault({ ...fixture, passphrase: Buffer.from('a completely different phrase') }));
  for (const field of ['saltBase64', 'ivBase64', 'ciphertextBase64', 'tagBase64']) {
    await rejected(openDeploymentSignerVault({ ...fixture, vault: { ...fixture.vault, [field]: flipBase64(fixture.vault[field]) }, passphrase }));
  }
  const changedId = copy(fixture.manifest); changedId.id = 'another-deployment';
  await rejected(openDeploymentSignerVault({ manifest: changedId, vault: { ...fixture.vault,
    id: changedId.id, manifestSha256: sha256Json(changedId) }, passphrase }));
});

test('manifest mismatch and authenticated swapped seed roles are rejected', async () => {
  const changed = copy(fixture.manifest); changed.steps[0].expected.name = 'Unapproved name';
  await rejected(openDeploymentSignerVault({ vault: fixture.vault, manifest: changed, passphrase }));
  const swapped = Buffer.concat([fixtureSeeds.subarray(32, 64), fixtureSeeds.subarray(0, 32), fixtureSeeds.subarray(64)]);
  try { await rejected(openDeploymentSignerVault({ manifest: fixture.manifest, vault: reencryptFixture(swapped), passphrase })); }
  finally { swapped.fill(0); }
  // Even a holder of the encryption password cannot turn a modified plan into
  // the approved fixed-price/fixed-authority deployment merely by re-MACing it.
  await rejected(openDeploymentSignerVault({ manifest: changed, vault: reencryptFixture(fixtureSeeds, changed), passphrase }));
});

test('changed payer, recipient/account, instruction data or step identity cannot obtain a partial signature', () => {
  const other = new PublicKey(new Uint8Array(32).fill(43));
  for (const mutate of [
    tx => { tx.message.staticAccountKeys[0] = other; },
    tx => { tx.message.staticAccountKeys[1] = other; },
    tx => { tx.message.compiledInstructions[0].data[1] ^= 1; },
    tx => { tx.message.compiledInstructions[0].accountKeyIndexes[0] = 0; },
  ]) throws(() => handle.partialSign(candidate('collection-create', mutate)));
  throws(() => handle.partialSign({ ...candidate(), stepId: 'reserve-create' }));
  throws(() => handle.partialSign({ ...candidate(), stepId: 'unknown-step' }));
  // The system allocation/payment destination in the machine transaction is
  // also bound byte-for-byte, even when the expected signer list is unchanged.
  throws(() => handle.partialSign(candidate('machine-create', tx => { tx.message.compiledInstructions[0].data[4] ^= 1; })));
});

test('already signed, partly signed and noncanonical transaction inputs are rejected', () => {
  throws(() => handle.partialSign(candidate('collection-create', tx => { tx.signatures[0][0] = 1; })));
  throws(() => handle.partialSign(candidate('collection-create', tx => { tx.signatures[1][0] = 1; })));
  const request = handle.partialSign(candidate());
  throws(() => handle.partialSign({ ...candidate(), transactionBase64: request.transactionBase64 }));
  const normal = candidate();
  for (const transactionBase64 of [`${normal.transactionBase64}\n`, '', Buffer.alloc(1233).toString('base64'),
    Buffer.concat([Buffer.from(normal.transactionBase64, 'base64'), Buffer.from([0])]).toString('base64')]) {
    throws(() => handle.partialSign({ ...normal, transactionBase64 }));
  }
  for (const change of [{ attempt: 0 }, { attempt: 1.5 }, { lastValidBlockHeight: 0 }, { owner: policy.owner }]) {
    throws(() => handle.partialSign({ ...normal, ...change }));
  }
});

test('passphrases are byte-only and schema errors never echo inputs or invoke getters', async () => {
  for (const phrase of ['secret-string-passphrase', new Uint8Array(15), new Uint8Array(1025), null, new Uint16Array(32)]) {
    await rejected(createDeploymentSignerVault({ ...publicOptions, passphrase: phrase }));
    await rejected(openDeploymentSignerVault({ ...fixture, passphrase: phrase }));
  }
  for (const change of [{ ownerPrivateKey: 'do-not-export' }, { id: '../secret' }, { cluster: 'unknown' },
    { machineRentLamports: '18446744073709551616' }, { lastValidBlockHeight: 0 }, { blockhash: 'credential-token' }]) {
    await rejected(createDeploymentSignerVault({ ...publicOptions, passphrase, ...change }));
  }
  const getter = { ...publicOptions, passphrase };
  Object.defineProperty(getter, 'id', { enumerable: true, get() { throw Error('secret-input'); } });
  await rejected(createDeploymentSignerVault(getter));
});

test('open snapshots caller data before await and the disposed handle cannot sign again', async () => {
  const mutable = copy(fixture), phrase = Buffer.from(passphrase);
  const opening = openDeploymentSignerVault({ ...mutable, passphrase: phrase });
  mutable.manifest.steps[0].expected.name = 'Changed while opening';
  mutable.vault.tagBase64 = flipBase64(mutable.vault.tagBase64); phrase.fill(0);
  const opened = await opening;
  assert.deepEqual(opened.partialSign(candidate()), handle.partialSign(candidate()));
  opened.dispose(); opened.dispose();
  throws(() => opened.partialSign(candidate()));
  assert.equal(JSON.stringify(opened), '{}');
});
