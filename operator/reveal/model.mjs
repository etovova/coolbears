// Private, offline reveal commitments. No wallet, RPC, upload or deployment API.
import { createHash } from 'node:crypto';
import { policy } from '../../scripts/hidden-metadata.mjs';
import { resolveStorageProfile } from '../storage-mode.mjs';
import { canonicalRevealValue as canonical, canonicalRevealJson } from './canonical-json.mjs';
export { canonicalRevealJson } from './canonical-json.mjs';

export const REVEAL_MANIFEST_KIND = 'stable-uri-private-reveal';
export const REVEAL_COMMITMENT_KIND = 'coolbears-content-mapping-v1';
const HEX = /^[0-9a-f]{64}$/;
const DOCUMENT_FIELDS = ['name', 'description', 'image', 'external_url', 'attributes', 'properties', 'animation_url', 'symbol', 'seller_fee_basis_points'];
const FORBIDDEN = /^(?:rank|rarity[_ -]?score|reserve|reserved|sourceIndex|artworkSha256|private|privateCID|secretKey|seed|passphrase)$/i;
class RevealError extends Error {
  constructor(code) { super('Private reveal input could not be used.'); this.code = `REVEAL_${code}`; }
}
const check = (condition, code = 'INVALID') => { if (!condition) throw new RevealError(code); };
function record(value) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  check(keys.every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
  return keys;
}
function exact(value, fields) {
  const keys = record(value);
  check(keys.length === fields.length && fields.every(field => keys.includes(field)));
}
function text(value, limit = 16384) {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= limit);
}
function safeUri(value) {
  text(value, 2048);
  let url; try { url = new URL(value); } catch { throw new RevealError('URI'); }
  check(['https:', 'ipfs:', 'ar:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'URI');
  check(url.protocol === 'https:' ? Boolean(url.hostname) : Boolean(url.hostname || url.pathname), 'URI');
  return value;
}
function noPrivateFields(value, depth = 0) {
  check(depth <= 24, 'SIZE');
  if (Array.isArray(value)) { for (const item of value) noPrivateFields(item, depth + 1); return; }
  if (value !== null && typeof value === 'object') {
    for (const key of record(value)) { check(!FORBIDDEN.test(key), 'PUBLIC_PRIVATE_FIELD'); noPrivateFields(value[key], depth + 1); }
  }
}
function validateDocument(document, index) {
  const keys = record(document);
  check(keys.every(key => DOCUMENT_FIELDS.includes(key)), 'DOCUMENT_FIELD');
  for (const required of ['name', 'description', 'image', 'external_url', 'attributes', 'properties']) check(keys.includes(required), 'DOCUMENT_FIELD');
  const expectedName = policy.revealedName.replace('{index:04d}', String(index).padStart(4, '0'));
  check(document.name === expectedName && !document.name.includes('Hidden Bear'), 'NAME');
  text(document.description); check(document.description !== policy.hiddenDescription, 'HIDDEN_DOCUMENT');
  safeUri(document.image); check(document.image !== `${policy.website}/assets/collection/gif.gif`, 'HIDDEN_DOCUMENT');
  check(document.external_url === policy.website, 'WEBSITE');
  check(Array.isArray(document.attributes), 'ATTRIBUTES');
  for (const attribute of document.attributes) {
    exact(attribute, ['trait_type', 'value']); text(attribute.trait_type, 256);
    check(!FORBIDDEN.test(attribute.trait_type), 'PUBLIC_PRIVATE_FIELD');
    check(['string', 'number', 'boolean'].includes(typeof attribute.value), 'ATTRIBUTES');
    if (typeof attribute.value === 'string') text(attribute.value, 2048);
    if (typeof attribute.value === 'number') check(Number.isFinite(attribute.value), 'ATTRIBUTES');
  }
  const propertyKeys = record(document.properties);
  check(propertyKeys.every(key => ['files', 'category', 'creators'].includes(key)), 'DOCUMENT_FIELD');
  check(document.properties.category === 'image' && Array.isArray(document.properties.files)
    && document.properties.files.length === 1, 'FILES');
  const file = document.properties.files[0]; exact(file, ['uri', 'type']);
  check(file.uri === document.image && file.type === 'image/png', 'FILES');
  if (Object.hasOwn(document.properties, 'creators')) {
    const creators = document.properties.creators;
    check(Array.isArray(creators) && creators.length === 1, 'ROYALTIES');
    const creatorKeys = record(creators[0]);
    check(creatorKeys.every(key => ['address', 'share', 'verified'].includes(key)), 'ROYALTIES');
    check(creators[0].address === policy.owner && creators[0].share === 100, 'ROYALTIES');
    if (creatorKeys.includes('verified')) check(typeof creators[0].verified === 'boolean', 'ROYALTIES');
  }
  if (keys.includes('seller_fee_basis_points')) check(document.seller_fee_basis_points === policy.royaltyPercent * 100, 'ROYALTIES');
  if (keys.includes('symbol')) text(document.symbol, 32);
  if (keys.includes('animation_url')) check(document.animation_url === document.image, 'FILES');
  noPrivateFields(document);
  const body = canonical(document) + '\n'; check(Buffer.byteLength(body, 'utf8') <= 65536, 'SIZE');
  return body;
}
export function revealUri(index) {
  check(Number.isSafeInteger(index) && index >= 0 && index < policy.supply, 'INDEX');
  return index === 0 ? `${policy.website}/metadata/hidden/0000.json` : `${policy.website}/metadata/hidden-indexed/${index}.json`;
}
export function validateRevealManifest(manifest) {
  exact(manifest, ['version', 'kind', 'owner', 'entries']);
  check(manifest.version === 1 && manifest.kind === REVEAL_MANIFEST_KIND && manifest.owner === policy.owner, 'MANIFEST');
  check(policy.supply === 10000 && policy.earliestRevealDate === '2027-01-01', 'POLICY');
  check(Array.isArray(manifest.entries) && manifest.entries.length === policy.supply, 'SUPPLY');
  const indices = new Set(), sources = new Set(), artworks = new Set(), entries = [];
  for (const entry of manifest.entries) {
    exact(entry, ['index', 'sourceIndex', 'rarityRank', 'artworkSha256', 'document']);
    check(Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index < policy.supply, 'INDEX');
    check(Number.isSafeInteger(entry.sourceIndex) && entry.sourceIndex >= 0 && entry.sourceIndex < policy.supply, 'INDEX');
    check(!indices.has(entry.index) && !sources.has(entry.sourceIndex), 'DUPLICATE');
    check(Number.isSafeInteger(entry.rarityRank) && entry.rarityRank >= 1 && entry.rarityRank <= policy.supply, 'RANK');
    check(typeof entry.artworkSha256 === 'string' && HEX.test(entry.artworkSha256) && !/^0+$/.test(entry.artworkSha256), 'ARTWORK_HASH');
    check(!artworks.has(entry.artworkSha256), 'DUPLICATE_ARTWORK');
    if (entry.index === 0) check(entry.sourceIndex === 0 && entry.rarityRank === 1, 'RESERVED');
    else check(entry.sourceIndex !== 0 && entry.rarityRank > 1, 'RESERVED');
    validateDocument(entry.document, entry.index);
    // Own a JSON-only snapshot: caller mutation cannot change the commitment.
    entries.push(JSON.parse(canonical(entry)));
    indices.add(entry.index); sources.add(entry.sourceIndex); artworks.add(entry.artworkSha256);
  }
  entries.sort((a, b) => a.index - b.index);
  return { version: 1, kind: REVEAL_MANIFEST_KIND, owner: policy.owner, entries };
}
export function revealJsonSha256(value) {
  return createHash('sha256').update(canonicalRevealJson(value), 'utf8').digest('hex');
}
function publicPolicy() {
  return { collectionName: policy.collectionName, supply: policy.supply, owner: policy.owner,
    priceSol: policy.priceSol, royaltyPercent: policy.royaltyPercent, earliestRevealDate: policy.earliestRevealDate,
    hiddenDescription: policy.hiddenDescription, revealedName: policy.revealedName, website: policy.website };
}
function publicEntry(entry) {
  return { index: entry.index, documentSha256: revealJsonSha256(entry.document), artworkSha256: entry.artworkSha256 };
}
function commitmentPayloadFromHashes(leafSha256) {
  // Resolve exact templates from the same contract used by deployment/accounts.
  const { hiddenSettings } = resolveStorageProfile(policy, {
    storageMode: 'hidden-settings', hiddenCommitmentSha256: leafSha256[0],
  });
  return { version: 1, kind: REVEAL_COMMITMENT_KIND, policy: publicPolicy(),
    onchainName: hiddenSettings.name, onchainUri: hiddenSettings.uri,
    internalOnchainName: policy.hiddenName.replace('{index:04d}', '0000'),
    internalOnchainUri: `${policy.website}/metadata/hidden/0000.json`, leafSha256 };
}
export function createRevealCommitment(manifest) {
  const validated = validateRevealManifest(manifest);
  const leafSha256 = validated.entries.map(entry => revealJsonSha256(publicEntry(entry)));
  return revealJsonSha256(commitmentPayloadFromHashes(leafSha256));
}
export function analyzeRevealManifest(manifest) {
  const hash = createRevealCommitment(manifest);
  // Safe review: no mapping, final URI, rank, reserve ID, private path or secret.
  return { version: 1, kind: REVEAL_COMMITMENT_KIND, commitmentSha256: hash,
    supply: policy.supply, publicItems: policy.supply - 1, salesOpen: false,
    earliestRevealDate: policy.earliestRevealDate, preparedOffline: true,
    finalArtworkBytesVerified: false, publicationPerformed: false,
    onchainRevealTransactions: 0, marketplaceRefreshVerified: false, finalImageAvailabilityVerified: false };
}
export async function verifyRevealArtwork(manifest, readArtwork) {
  const validated = validateRevealManifest(manifest);
  check(typeof readArtwork === 'function', 'ARTWORK_READER');
  for (const entry of validated.entries) {
    // Explicit local caller capability, no URI fetching or writes.
    let bytes; try { bytes = await readArtwork(entry.sourceIndex); } catch { throw new RevealError('ARTWORK_READ'); }
    check(bytes instanceof Uint8Array && bytes.length >= 8 && bytes.length <= 32 * 1024 * 1024, 'ARTWORK_BYTES');
    check(Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'ARTWORK_PNG');
    check(createHash('sha256').update(bytes).digest('hex') === entry.artworkSha256, 'ARTWORK_HASH');
  }
  return { commitmentSha256: createRevealCommitment(validated), supply: policy.supply, finalArtworkBytesVerified: true };
}
function revealGates({ expectedCommitmentSha256, now, revealAuthorized, marketplaceRefreshAcknowledged }) {
  check(typeof expectedCommitmentSha256 === 'string' && HEX.test(expectedCommitmentSha256), 'COMMITMENT');
  check(typeof now === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(now)
    && Number.isFinite(Date.parse(now)), 'TIME');
  const normalized = new Date(now).toISOString();
  check(normalized === now || normalized.replace('.000Z', 'Z') === now, 'TIME');
  check(Date.parse(now) >= Date.parse(`${policy.earliestRevealDate}T00:00:00.000Z`), 'TOO_EARLY');
  check(revealAuthorized === true, 'AUTHORIZATION');
  check(marketplaceRefreshAcknowledged === true, 'REFRESH');
}
export function verifyPublicRevealProof(proof) {
  exact(proof, ['version', 'kind', 'commitmentSha256', 'anchorSha256', 'entries']);
  check(proof.version === 1 && proof.kind === 'stable-uri-reveal-content-proof', 'PROOF');
  check(typeof proof.anchorSha256 === 'string' && typeof proof.commitmentSha256 === 'string'
    && HEX.test(proof.anchorSha256) && HEX.test(proof.commitmentSha256), 'COMMITMENT');
  check(Array.isArray(proof.entries) && proof.entries.length === policy.supply - 1, 'SUPPLY');
  const leaves = [proof.anchorSha256];
  for (let i = 0; i < proof.entries.length; i++) {
    const entry = proof.entries[i]; exact(entry, ['index', 'documentSha256', 'artworkSha256']);
    check(entry.index === i + 1, 'INDEX');
    check(typeof entry.documentSha256 === 'string' && typeof entry.artworkSha256 === 'string'
      && HEX.test(entry.documentSha256) && HEX.test(entry.artworkSha256), 'COMMITMENT');
    leaves.push(revealJsonSha256(entry));
  }
  check(revealJsonSha256(commitmentPayloadFromHashes(leaves)) === proof.commitmentSha256, 'COMMITMENT');
  return { commitmentSha256: proof.commitmentSha256, publicItems: proof.entries.length,
    publicContentCommitmentVerified: true, privateAnchorContentDisclosed: false };
}
export async function prepareRevealPayload(manifest, { expectedCommitmentSha256, now, revealAuthorized = false,
  marketplaceRefreshAcknowledged = false, readArtwork } = {}) {
  revealGates({ expectedCommitmentSha256, now, revealAuthorized, marketplaceRefreshAcknowledged });
  const validated = validateRevealManifest(manifest);
  check(createRevealCommitment(validated) === expectedCommitmentSha256, 'COMMITMENT');
  await verifyRevealArtwork(validated, readArtwork);
  const proof = { version: 1, kind: 'stable-uri-reveal-content-proof', commitmentSha256: expectedCommitmentSha256,
    anchorSha256: revealJsonSha256(publicEntry(validated.entries[0])),
    entries: validated.entries.slice(1).map(publicEntry) };
  verifyPublicRevealProof(proof);
  const proofBody = canonicalRevealJson(proof), proofSha256 = revealJsonSha256(proof);
  const runtimeConfig = { version: 1, kind: 'stable-uri-reveal-runtime', revealAuthorized: true,
    commitmentSha256: expectedCommitmentSha256, proofSha256, earliestRevealDate: policy.earliestRevealDate, preparedAt: now };
  return { version: 1, kind: 'stable-uri-reveal-private-staging', commitmentSha256: expectedCommitmentSha256,
    preparedAt: now, publicationPerformed: false, salesOpen: false, onchainRevealTransactions: 0,
    finalArtworkBytesVerified: true, marketplaceRefreshVerified: false, finalImageAvailabilityVerified: false, proof, proofBody, proofSha256, runtimeConfig,
    files: validated.entries.slice(1).map(entry => ({ path: `metadata/hidden/${String(entry.index).padStart(4, '0')}.json`,
      body: canonicalRevealJson(entry.document) })) };
}
