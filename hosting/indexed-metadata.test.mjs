import test from 'node:test';
import assert from 'node:assert/strict';
import { policy } from '../scripts/hidden-metadata.mjs';
import { canonicalRevealJson } from '../operator/reveal/model.mjs';
import { createIndexedMetadataWorker, validateIndexedRevealProof } from './indexed-metadata-worker.mjs';
import { hidden, final, commitment, proof, proofBody, proofHash, releaseOptions } from './indexed-metadata.fixture.mjs';

function assets(documents = hidden, proofText = proofBody) {
  const calls = [];
  return { calls, ASSETS: { async fetch(request) {
    const url = new URL(request.url); calls.push(url.pathname);
    if (url.pathname === '/metadata/reveal-proof.json') return new Response(proofText);
    const match = /^\/metadata\/hidden\/(\d{4})\.json$/.exec(url.pathname);
    if (match) return new Response(canonicalRevealJson(documents[Number(match[1])]));
    return new Response('unchanged static asset');
  } } };
}
const request = (path, method = 'GET') => new Request(policy.website + path, { method });
test('aliases every public index, preserves approved JSON and no-store/CORS', async () => {
  const worker = createIndexedMetadataWorker(), env = assets();
  for (const i of [1, 9, 10, 99, 100, 999, 1000, 9999]) {
    const result = await worker.fetch(request(`/metadata/hidden-indexed/${i}.json`), env);
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), hidden[i]);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
  }
  assert.ok(env.calls.every(p => /^\/metadata\/hidden\/\d{4}\.json$/.test(p)));
});
test('invalid, internal, zero-padded indexed and query URLs do not reach assets', async () => {
  const worker = createIndexedMetadataWorker(), env = assets();
  for (const path of ['/metadata/hidden-indexed/0.json', '/metadata/hidden-indexed/0001.json',
    '/metadata/hidden-indexed/10000.json', '/metadata/hidden-indexed/%31.json',
    '/metadata/%68idden/0001.json', '/metad%61ta/hidden/0001.json',
    '//metadata/hidden/0001.json', '/metadata//hidden/0001.json',
    '/metadata/hidden-indexed/1.json?reveal=true', '/metadata/hidden-indexed/proof.json']) {
    assert.equal((await worker.fetch(request(path), env)).status, 404);
  }
  assert.equal((await worker.fetch(new Request('https://evil.invalid/metadata/hidden-indexed/1.json'), env)).status, 404);
  assert.equal(env.calls.length, 0);
});
test('HEAD has no body, write methods reject, unrelated assets delegate unchanged', async () => {
  const worker = createIndexedMetadataWorker(), env = assets();
  const head = await worker.fetch(request('/metadata/hidden-indexed/1.json', 'HEAD'), env);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const result = await worker.fetch(request('/metadata/hidden-indexed/1.json', method), env);
    assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal(await (await worker.fetch(request('/config.js'), env)).text(), 'unchanged static asset');
});
test('calendar passage does not reveal; accidentally staged final data fail closed', async () => {
  const worker = createIndexedMetadataWorker({ now: releaseOptions.now });
  assert.equal((await worker.fetch(request('/metadata/hidden-indexed/1.json'), assets(final))).status, 503);
  assert.equal((await worker.fetch(request('/metadata/hidden/0001.json'), assets(final))).status, 503);
  assert.equal((await worker.fetch(request('/metadata/reveal-proof.json'), assets())).status, 404);
  for (const changed of [{ ...hidden[1], privateCID: 'fixture-private' },
    { ...hidden[1], properties: { ...hidden[1].properties, files: [{ uri: 'https://example.invalid/final.png', type: 'image/png' }] } },
    { ...hidden[1], animation_url: 'https://example.invalid/final.png' }]) {
    const docs = [...hidden]; docs[1] = changed;
    assert.equal((await worker.fetch(request('/metadata/hidden-indexed/1.json'), assets(docs))).status, 503);
  }
});
test('authorized reveal cannot serve content or proof before the policy date', async () => {
  const worker = createIndexedMetadataWorker({ ...releaseOptions, now: () => Date.parse('2026-12-31T23:59:59.999Z') });
  const env = assets(final);
  for (const path of ['/metadata/hidden-indexed/1.json', '/metadata/hidden/0001.json', '/metadata/reveal-proof.json']) {
    assert.equal((await worker.fetch(request(path), env)).status, 503);
  }
  assert.equal(env.calls.length, 0);
});
test('full independent WebCrypto proof agrees with offline commitment', async () => {
  const hashes = await validateIndexedRevealProof(proof, commitment);
  assert.equal(hashes.size, 9999); assert.equal(hashes.get(9999), proof.entries[9998].documentSha256);
  const changed = structuredClone(proof); changed.entries[1].artworkSha256 = 'a'.repeat(64);
  await assert.rejects(validateIndexedRevealProof(changed, commitment), /METADATA_NOT_VERIFIED/);
  await assert.rejects(validateIndexedRevealProof(proof, 'b'.repeat(64)), /METADATA_NOT_VERIFIED/);
});
test('gated exact final content works at both stable URLs without chain updates', async () => {
  const worker = createIndexedMetadataWorker(releaseOptions), docs = [...final]; docs[0] = hidden[0];
  const env = assets(docs);
  for (const path of ['/metadata/hidden-indexed/1.json', '/metadata/hidden/9999.json']) {
    const result = await worker.fetch(request(path), env); assert.equal(result.status, 200);
    assert.ok(!(await result.json()).name.includes('Hidden Bear'));
  }
  assert.equal((await worker.fetch(request('/metadata/hidden/0000.json'), env)).status, 200);
  assert.equal(env.calls.filter(p => p === '/metadata/reveal-proof.json').length, 1);
  const proofResponse = await worker.fetch(request('/metadata/reveal-proof.json'), assets(docs, 'unverified changed proof'));
  assert.equal(await proofResponse.text(), proofBody);
});
test('altered final JSON, proof bytes or commitment are refused without secret output', async () => {
  const docs = [...final]; docs[1] = { ...final[1], image: 'https://example.invalid/tampered.png' };
  const worker = createIndexedMetadataWorker(releaseOptions);
  assert.equal((await worker.fetch(request('/metadata/hidden-indexed/1.json'), assets(docs))).status, 503);
  const wrongProofWorker = createIndexedMetadataWorker(releaseOptions);
  assert.equal((await wrongProofWorker.fetch(request('/metadata/hidden-indexed/1.json'), assets(final, proofBody + ' '))).status, 503);
  assert.throws(() => createIndexedMetadataWorker({ ...releaseOptions, trustedProofSha256: null }), /METADATA_NOT_VERIFIED/);
  assert.throws(() => createIndexedMetadataWorker({ trustedCommitmentSha256: commitment }), /METADATA_NOT_VERIFIED/);
});
