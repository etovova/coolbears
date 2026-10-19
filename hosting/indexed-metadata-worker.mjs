// Stable metadata aliases. This module cannot mint, sign or call external RPC.
import policy from '../metadata/policy.json' with { type: 'json' };
import hiddenTemplate from '../metadata/0000.json' with { type: 'json' };
import { canonicalRevealJson } from '../operator/reveal/canonical-json.mjs';

const HEX = /^[0-9a-f]{64}$/;
const origin = new URL(policy.website).origin;
const earliest = Date.parse(`${policy.earliestRevealDate}T00:00:00.000Z`);
const encoder = new TextEncoder();
const need = condition => { if (!condition) throw Error('METADATA_NOT_VERIFIED'); };
const exact = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
async function sha(value) {
  return shaBody(canonicalRevealJson(value));
}
async function shaBody(body) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
function commitmentPayload(leaves) {
  return { version: 1, kind: 'coolbears-content-mapping-v1',
    policy: { collectionName: policy.collectionName, supply: policy.supply, owner: policy.owner,
      priceSol: policy.priceSol, royaltyPercent: policy.royaltyPercent, earliestRevealDate: policy.earliestRevealDate,
      hiddenDescription: policy.hiddenDescription, revealedName: policy.revealedName, website: policy.website },
    onchainName: policy.revealedName.replace('{index:04d}', '$ID+1$'),
    onchainUri: `${policy.website}/metadata/hidden-indexed/$ID+1$.json`,
    internalOnchainName: policy.hiddenName.replace('{index:04d}', '0000'),
    internalOnchainUri: `${policy.website}/metadata/hidden/0000.json`, leafSha256: leaves };
}
export async function validateIndexedRevealProof(proof, trustedCommitmentSha256) {
  need(typeof trustedCommitmentSha256 === 'string' && HEX.test(trustedCommitmentSha256));
  exact(proof, ['version', 'kind', 'commitmentSha256', 'anchorSha256', 'entries']);
  need(proof.version === 1 && proof.kind === 'stable-uri-reveal-content-proof'
    && proof.commitmentSha256 === trustedCommitmentSha256 && HEX.test(proof.anchorSha256)
    && Array.isArray(proof.entries) && proof.entries.length === policy.supply - 1);
  const leaves = [proof.anchorSha256], hashes = new Map();
  for (let i = 0; i < proof.entries.length; i++) {
    const entry = proof.entries[i]; exact(entry, ['index', 'documentSha256', 'artworkSha256']);
    need(entry.index === i + 1 && typeof entry.documentSha256 === 'string' && HEX.test(entry.documentSha256)
      && typeof entry.artworkSha256 === 'string' && HEX.test(entry.artworkSha256));
    leaves.push(await sha(entry)); hashes.set(entry.index, entry.documentSha256);
  }
  need(await sha(commitmentPayload(leaves)) === trustedCommitmentSha256);
  return hashes;
}
function metadataIndex(pathname) {
  const indexed = /^\/metadata\/hidden-indexed\/([1-9][0-9]{0,3})\.json$/.exec(pathname);
  if (indexed) { const index = Number(indexed[1]); return index < policy.supply ? index : null; }
  const padded = /^\/metadata\/hidden\/([0-9]{4})\.json$/.exec(pathname);
  return padded ? Number(padded[1]) : null;
}
function response(status, body = null, extraHeaders = {}) {
  return new Response(body, { status, headers: { 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', ...extraHeaders } });
}
function isHidden(document, index) {
  const expected = { ...hiddenTemplate, name: policy.hiddenName.replace('{index:04d}', String(index).padStart(4, '0')) };
  // Exact canonical comparison includes nested files/animation fields and
  // rejects arbitrary extra fields, even when the displayed image is a GIF.
  return canonicalRevealJson(document) === canonicalRevealJson(expected);
}

export function createIndexedMetadataWorker({ revealAuthorized = false, trustedCommitmentSha256 = null,
  trustedProofSha256 = null, now = () => Date.now() } = {}) {
  need(typeof revealAuthorized === 'boolean' && typeof now === 'function');
  if (revealAuthorized) need(typeof trustedCommitmentSha256 === 'string' && HEX.test(trustedCommitmentSha256)
    && typeof trustedProofSha256 === 'string' && HEX.test(trustedProofSha256));
  else need(trustedCommitmentSha256 === null && trustedProofSha256 === null);
  let verifiedProof = null;
  async function releaseHashes(env) {
    if (!verifiedProof) verifiedProof = (async () => {
      const result = await env.ASSETS.fetch(new Request(origin + '/metadata/reveal-proof.json'));
      need(result.status === 200);
      const body = await result.text(); need(encoder.encode(body).length <= 3 * 1024 * 1024);
      // The full commitment proof is verified in the gated offline release
      // build. Its exact bytes and commitment are pinned in that deployment;
      // do not redo 10,000 leaf hashes for every cold Worker instance.
      need(await shaBody(body) === trustedProofSha256);
      const proof = JSON.parse(body);
      exact(proof, ['version', 'kind', 'commitmentSha256', 'anchorSha256', 'entries']);
      need(proof.version === 1 && proof.kind === 'stable-uri-reveal-content-proof'
        && proof.commitmentSha256 === trustedCommitmentSha256 && HEX.test(proof.anchorSha256)
        && Array.isArray(proof.entries) && proof.entries.length === policy.supply - 1);
      const hashes = new Map();
      for (let i = 0; i < proof.entries.length; i++) {
        const entry = proof.entries[i]; exact(entry, ['index', 'documentSha256', 'artworkSha256']);
        need(entry.index === i + 1 && HEX.test(entry.documentSha256) && HEX.test(entry.artworkSha256));
        hashes.set(entry.index, entry.documentSha256);
      }
      return { hashes, body };
    })().catch(error => { verifiedProof = null; throw error; });
    return verifiedProof;
  }
  return { async fetch(request, env) {
    const url = new URL(request.url);
    let decoded;
    try { decoded = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/'); } catch { return response(404); }
    const controlled = decoded.startsWith('/metadata/hidden-indexed/')
      || decoded.startsWith('/metadata/hidden/') || decoded === '/metadata/reveal-proof.json';
    if (!controlled) return env.ASSETS.fetch(request);
    if (url.origin !== origin || decoded !== url.pathname || url.search || url.hash) return response(404);
    if (!['GET', 'HEAD'].includes(request.method)) return response(405, null, { allow: 'GET, HEAD' });
    const instant = now();
    if (!Number.isSafeInteger(instant) || (revealAuthorized && instant < earliest)) return response(503);
    if (url.pathname === '/metadata/reveal-proof.json') {
      if (!revealAuthorized) return response(404);
      try {
        const { body } = await releaseHashes(env);
        return response(200, request.method === 'HEAD' ? null : body, { 'content-type': 'application/json' });
      } catch { return response(503); }
    }
    const index = metadataIndex(url.pathname);
    if (index === null) return response(404);
    try {
      const paddedPath = `/metadata/hidden/${String(index).padStart(4, '0')}.json`;
      const source = await env.ASSETS.fetch(new Request(origin + paddedPath));
      need(source.status === 200);
      const body = await source.text(); need(encoder.encode(body).length <= 65536);
      const document = JSON.parse(body);
      if (!revealAuthorized || index === 0) need(isHidden(document, index));
      else {
        const { hashes } = await releaseHashes(env);
        need(await sha(document) === hashes.get(index));
        need(document.name === policy.revealedName.replace('{index:04d}', String(index).padStart(4, '0'))
          && document.image !== `${policy.website}/assets/collection/gif.gif`);
      }
      return response(200, request.method === 'HEAD' ? null : body, { 'content-type': 'application/json; charset=utf-8' });
    } catch { return response(503); }
  } };
}

// Activation requires a separately reviewed future deployment. The default
// candidate serves placeholders even after the calendar date has passed.
let configured = null;
export default { async fetch(request, env) {
  try {
    const authorized = env.METADATA_REVEAL === 'authorized';
    if (!configured) configured = createIndexedMetadataWorker({ revealAuthorized: authorized,
      trustedCommitmentSha256: authorized ? env.REVEAL_COMMITMENT_SHA256 : null,
      trustedProofSha256: authorized ? env.REVEAL_PROOF_SHA256 : null });
    return await configured.fetch(request, env);
  } catch { return response(503); }
} };
