// Disposable synthetic metadata only; never a production commitment.
import { createHash } from 'node:crypto';
import { hiddenDocuments, policy } from '../scripts/hidden-metadata.mjs';
import { createRevealCommitment, canonicalRevealJson, revealJsonSha256 } from '../operator/reveal/model.mjs';
const hidden = hiddenDocuments();
const final = hidden.map((doc, i) => ({ name: policy.revealedName.replace('{index:04d}', String(i).padStart(4, '0')),
  description: policy.collectionDescription, image: `https://example.invalid/fixture/${i}.png`, external_url: policy.website,
  attributes: [], properties: { category: 'image', files: [{ uri: `https://example.invalid/fixture/${i}.png`, type: 'image/png' }] } }));
const manifest = { version: 1, kind: 'stable-uri-private-reveal', owner: policy.owner,
  entries: final.map((document, index) => ({ index, sourceIndex: index, rarityRank: index + 1,
    artworkSha256: createHash('sha256').update(`fixture-only-art-${index}`).digest('hex'), document })) };
const commitment = createRevealCommitment(manifest);
const entries = manifest.entries.map(entry => ({ index: entry.index,
  documentSha256: revealJsonSha256(entry.document), artworkSha256: entry.artworkSha256 }));
const proof = { version: 1, kind: 'stable-uri-reveal-content-proof', commitmentSha256: commitment,
  anchorSha256: revealJsonSha256(entries[0]), entries: entries.slice(1) };
const proofBody = canonicalRevealJson(proof);
const proofHash = createHash('sha256').update(proofBody).digest('hex');
const releaseOptions = { revealAuthorized: true, trustedCommitmentSha256: commitment, trustedProofSha256: proofHash,
  now: () => Date.parse('2027-01-02T00:00:00.000Z') };
export { hidden, final, commitment, proof, proofBody, proofHash, releaseOptions };
