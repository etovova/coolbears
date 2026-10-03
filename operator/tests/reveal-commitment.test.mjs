// Entirely synthetic fixtures. No real final metadata, wallets or chain state.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, lstat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { policy } from '../../scripts/hidden-metadata.mjs';
import { canonicalRevealJson } from '../reveal/canonical-json.mjs';
import { validateRevealManifest, createRevealCommitment, analyzeRevealManifest, prepareRevealPayload,
  verifyPublicRevealProof, verifyRevealArtwork, revealJsonSha256, revealUri } from '../reveal/model.mjs';
import { readPrivateRevealBytes, readPrivateRevealManifest, saveRevealCommitment, stagePrivateReveal } from '../reveal/store.mjs';
import { runRevealCli } from '../reveal/cli.mjs';
const png = index => { const bytes = Buffer.alloc(12); bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(index, 8); return bytes; };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  return { version: 1, kind: 'stable-uri-private-reveal', owner: policy.owner,
    entries: Array.from({ length: 10000 }, (_, index) => ({ index, sourceIndex: index, rarityRank: index + 1,
      artworkSha256: digest(png(index)), document: {
        name: policy.revealedName.replace('{index:04d}', String(index).padStart(4, '0')),
        description: 'Synthetic final document; never published.', image: `https://example.invalid/${index}.png`,
        external_url: policy.website, attributes: [{ trait_type: 'Fixture', value: 'PRIVATE_SENTINEL' }],
        properties: { files: [{ uri: `https://example.invalid/${index}.png`, type: 'image/png' }], category: 'image' },
      } })) };
}
const manifest = fixture();
const commitment = createRevealCommitment(manifest);
const gates = () => ({ expectedCommitmentSha256: commitment, now: '2027-01-01T00:00:00.000Z',
  revealAuthorized: true, marketplaceRefreshAcknowledged: true, readArtwork: async index => png(index) });
const reject = (call, code) => assert.throws(call, error => error.code === code && !error.message.includes('PRIVATE_SENTINEL'));
const rejects = (call, code) => assert.rejects(call, error => error.code === code && !error.message.includes('PRIVATE_SENTINEL'));

test('full10k commitment is deterministic, input order/key order independent, contentbound and private', () => {
  assert.match(commitment, /^[0-9a-f]{64}$/);
  const reversed = { entries: [...manifest.entries].reverse(), owner: manifest.owner, kind: manifest.kind, version: 1 };
  assert.equal(createRevealCommitment(reversed), commitment);
  const changed = structuredClone(manifest); changed.entries[1].document.attributes[0].value = 'Other final bear';
  assert.notEqual(createRevealCommitment(changed), commitment);
  const art = structuredClone(manifest); art.entries[1].artworkSha256 = 'a'.repeat(64);
  assert.notEqual(createRevealCommitment(art), commitment);
  const report = analyzeRevealManifest(manifest), body = JSON.stringify(report);
  for (const secret of ['PRIVATE_SENTINEL', 'example.invalid', 'sourceIndex', 'rarityRank', 'reserved', 'CoolBears #0000', '0000.json', '"index":0']) assert.ok(!body.includes(secret));
  assert.equal(report.finalArtworkBytesVerified, false); assert.equal(report.publicationPerformed, false);
  assert.equal(report.salesOpen, false); assert.equal(report.finalImageAvailabilityVerified, false);
  assert.equal(revealUri(1), `${policy.website}/metadata/hidden-indexed/1.json`);
  assert.equal(revealUri(0), `${policy.website}/metadata/hidden/0000.json`);
});

test('missing,duplicate,outofrange,supply,mapping and reservepolicy are rejected', () => {
  const cases = [
    [m => m.entries.pop(), 'REVEAL_SUPPLY'],
    [m => m.entries[1].index = 0, 'REVEAL_DUPLICATE'],
    [m => m.entries[0].index = 10000, 'REVEAL_INDEX'],
    [m => m.entries[1].sourceIndex = 0, 'REVEAL_DUPLICATE'],
    [m => m.entries[0].sourceIndex = 1, 'REVEAL_RESERVED'],
    [m => m.entries[0].rarityRank = 2, 'REVEAL_RESERVED'],
    [m => m.entries[1].rarityRank = 1, 'REVEAL_RESERVED'],
    [m => m.entries[0].rarityRank = NaN, 'REVEAL_RANK'],
    [m => m.entries[1].artworkSha256 = m.entries[0].artworkSha256, 'REVEAL_DUPLICATE_ARTWORK'],
    [m => m.entries[0].artworkSha256 = '0'.repeat(64), 'REVEAL_ARTWORK_HASH'],
    [m => m.owner = 'Wrong owner', 'REVEAL_MANIFEST'],
  ];
  for (const [change, code] of cases) { const m = structuredClone(manifest); change(m); reject(() => validateRevealManifest(m), code); }
});

test('revealeddocuments must retain identity, approvedPNGshape,price royalties and no privatefields', () => {
  const approvedRarity = structuredClone(manifest); approvedRarity.entries[0].document.attributes[0].trait_type = 'Rarity';
  assert.equal(validateRevealManifest(approvedRarity).entries.length, 10000);
  const cases = [
    [d => d.name = 'CoolBears #1', 'REVEAL_NAME'],
    [d => d.description = policy.hiddenDescription, 'REVEAL_HIDDEN_DOCUMENT'],
    [d => d.image = `${policy.website}/assets/collection/gif.gif`, 'REVEAL_HIDDEN_DOCUMENT'],
    [d => d.rank = 1, 'REVEAL_DOCUMENT_FIELD'],
    [d => d.attributes[0].trait_type = 'rarity_score', 'REVEAL_PUBLIC_PRIVATE_FIELD'],
    [d => d.properties.secretKey = 'PRIVATE_SENTINEL', 'REVEAL_DOCUMENT_FIELD'],
    [d => d.external_url = 'https://example.invalid', 'REVEAL_WEBSITE'],
    [d => d.seller_fee_basis_points = 500, 'REVEAL_ROYALTIES'],
    [d => d.properties.files[0].uri = 'https://example.invalid/wrong.png', 'REVEAL_FILES'],
    [d => d.properties.files[0].type = 'image/gif', 'REVEAL_FILES'],
    [d => d.image = 'https://user:secret@example.invalid/0.png', 'REVEAL_URI'],
  ];
  for (const [change, code] of cases) { const m = structuredClone(manifest); change(m.entries[0].document); reject(() => validateRevealManifest(m), code); }
});

test('canonical serializer matches browserTextEncoderUTF8, rejects getters,sparse arrays,hiddenkeys and invalidnumbers', () => {
  const data = { z: 'Медведь🐻', a: [{ q: true, b: 1 }], n: null };
  assert.equal(canonicalRevealJson(data), '{"a":[{"b":1,"q":true}],"n":null,"z":"Медведь🐻"}\n');
  assert.equal(revealJsonSha256(data), digest(new TextEncoder().encode(canonicalRevealJson(data))));
  const getter = { get private() { throw Error('PRIVATE_SENTINEL'); } };
  for (const value of [getter, [1,,2], { x: NaN }, { x: Infinity }, { x: -0 }, { x: undefined }, new Date(), Object.defineProperty({}, 'x', { value: 1 })]) {
    assert.throws(() => canonicalRevealJson(value), error => error.code.startsWith('REVEAL_') && !error.message.includes('PRIVATE_SENTINEL'));
  }
});

test('original artwork verification uses all explicit localbytes and rejects a swappedsource,failedread or nonPNG', async () => {
  const report = await verifyRevealArtwork(manifest, async index => png(index));
  assert.equal(report.commitmentSha256, commitment); assert.equal(report.finalArtworkBytesVerified, true);
  await rejects(() => verifyRevealArtwork(manifest, async index => png(index + 1)), 'REVEAL_ARTWORK_HASH');
  const swapped = structuredClone(manifest);
  [swapped.entries[1].sourceIndex, swapped.entries[2].sourceIndex] = [swapped.entries[2].sourceIndex, swapped.entries[1].sourceIndex];
  assert.equal(createRevealCommitment(swapped), commitment); // Private field excluded from public digest.
  await rejects(() => verifyRevealArtwork(swapped, async index => png(index)), 'REVEAL_ARTWORK_HASH');
  await rejects(() => verifyRevealArtwork(manifest, async () => { throw Error('PRIVATE_SENTINEL'); }), 'REVEAL_ARTWORK_READ');
  await rejects(() => verifyRevealArtwork(manifest, async () => Buffer.alloc(12)), 'REVEAL_ARTWORK_PNG');
});

test('early reveal,missingexplicit gates,invaliddates,wrongcommitment and unverifiedart cannot createpayload', async () => {
  const cases = [
    [{ now: '2026-12-31T23:59:59.999Z' }, 'REVEAL_TOO_EARLY'],
    [{ now: '2027-02-31T00:00:00.000Z' }, 'REVEAL_TIME'],
    [{ now: '2027-01-01T03:00:00+03:00' }, 'REVEAL_TIME'],
    [{ revealAuthorized: false }, 'REVEAL_AUTHORIZATION'],
    [{ marketplaceRefreshAcknowledged: false }, 'REVEAL_REFRESH'],
    [{ expectedCommitmentSha256: 'a'.repeat(64) }, 'REVEAL_COMMITMENT'],
    [{ readArtwork: undefined }, 'REVEAL_ARTWORK_READER'],
  ];
  for (const [change, code] of cases) await rejects(() => prepareRevealPayload(manifest, { ...gates(), ...change }), code);
});

let payload;
test('gated payload replacesonly existingpublicJSONpaths; proof is publicverifiable withoutreserve/private mapping', async () => {
  payload = await prepareRevealPayload(manifest, gates());
  assert.equal(payload.files.length, 9999); assert.equal(payload.files[0].path, 'metadata/hidden/0001.json');
  assert.equal(payload.files.at(-1).path, 'metadata/hidden/9999.json');
  assert.equal(payload.files.some(file => file.path.includes('/0000.json')), false);
  assert.equal(payload.publicationPerformed, false); assert.equal(payload.onchainRevealTransactions, 0);
  assert.equal(digest(Buffer.from(payload.proofBody)), payload.proofSha256);
  assert.equal(payload.runtimeConfig.proofSha256, payload.proofSha256);
  assert.equal(payload.runtimeConfig.commitmentSha256, commitment);
  assert.equal(payload.finalArtworkBytesVerified, true); assert.equal(payload.marketplaceRefreshVerified, false);
  assert.equal(verifyPublicRevealProof(payload.proof).commitmentSha256, commitment);
  const proofJson = JSON.stringify(payload.proof);
  for (const secret of ['PRIVATE_SENTINEL', 'example.invalid', 'sourceIndex', 'rarityRank', 'reserved', 'CoolBears #0000', '0000.json', '"index":0']) assert.ok(!proofJson.includes(secret));
  const tampered = structuredClone(payload.proof); tampered.entries[0].documentSha256 = 'b'.repeat(64);
  reject(() => verifyPublicRevealProof(tampered), 'REVEAL_COMMITMENT');
  const extraPrivate = structuredClone(payload.proof); extraPrivate.entries[0].rarityRank = 3;
  reject(() => verifyPublicRevealProof(extraPrivate), 'REVEAL_INVALID');
  const wrongIndex = structuredClone(payload.proof); wrongIndex.entries[0].index = 0;
  reject(() => verifyPublicRevealProof(wrongIndex), 'REVEAL_INDEX');
  const reordered = structuredClone(payload.proof); reordered.entries.reverse();
  reject(() => verifyPublicRevealProof(reordered), 'REVEAL_INDEX');
  assert.equal(revealJsonSha256(JSON.parse(payload.files[0].body)), payload.proof.entries[0].documentSha256);
});

test('privateinputpermissions,symlinks,limits,UTF8 and CLIredaction are enforced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-reveal-fixture-'));
  const filename = path.join(root, 'manifest.json'); await writeFile(filename, JSON.stringify(manifest), { mode: 0o600 });
  assert.equal((await readPrivateRevealManifest(filename)).entries.length, 10000);
  await chmod(filename, 0o644); await rejects(() => readPrivateRevealManifest(filename), 'REVEAL_FILE_PERMISSIONS'); await chmod(filename, 0o600);
  const link = path.join(root, 'linked.json'); await symlink(filename, link); await rejects(() => readPrivateRevealBytes(link), 'REVEAL_FILE_PATH');
  await rejects(() => readPrivateRevealBytes(filename, 10), 'REVEAL_FILE_SIZE');
  await rejects(() => readPrivateRevealBytes(filename, Infinity), 'REVEAL_FILE_SIZE');
  const bad = path.join(root, 'bad.json'); await writeFile(bad, Buffer.from([0xff]), { mode: 0o600 });
  await rejects(() => readPrivateRevealManifest(bad), 'REVEAL_FILE_JSON');
  const chunks = [], errors = [], io = { output: { write: s => chunks.push(s) }, error: { write: s => errors.push(s) } };
  assert.equal(await runRevealCli(['commitment', path.join(root, 'PRIVATE_SENTINEL'), path.join(root, 'new')], io), 1);
  assert.equal(chunks.length, 0); assert.equal(errors.join('').includes('PRIVATE_SENTINEL'), false);
});

test('offlinecommitment is preserved and stagefailsbeforewritingonmissinggates; none canoverwrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coolbears-reveal-output-')), output = path.join(root, 'commitment');
  await saveRevealCommitment(output, manifest); assert.equal((await lstat(output)).mode & 0o777, 0o700);
  const bytes = await readFile(path.join(output, 'commitment.json'));
  assert.equal((await lstat(path.join(output, 'commitment.json'))).mode & 0o777, 0o600);
  await assert.rejects(() => saveRevealCommitment(output, manifest));
  assert.deepEqual(await readFile(path.join(output, 'commitment.json')), bytes);
  const denied = path.join(root, 'denied');
  await rejects(() => stagePrivateReveal(denied, manifest, { ...gates(), revealAuthorized: false }), 'REVEAL_AUTHORIZATION');
  await assert.rejects(() => access(denied));
  // Real filesystem staging is exercised with a full10k synthetic manifest.
  const staged = path.join(root, 'staged'); const report = await stagePrivateReveal(staged, manifest, gates());
  assert.equal(report.publicItems, 9999); assert.equal(report.publicationPerformed, false);
  const ready = JSON.parse(await readFile(path.join(staged, 'READY.json')));
  assert.equal(ready.onchainRevealTransactions, 0); assert.equal(ready.finalImageAvailabilityVerified, false);
  await assert.rejects(() => access(path.join(staged, 'metadata/hidden/0000.json')));
  assert.equal(JSON.parse(await readFile(path.join(staged, 'metadata/hidden/0001.json'))).name, 'CoolBears #0001');
  assert.equal(verifyPublicRevealProof(JSON.parse(await readFile(path.join(staged, 'content-proof.json')))).commitmentSha256, commitment);
});
