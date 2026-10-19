// Synthetic local probes only. No real metadata URI, signing or RPC path.
import assert from 'node:assert/strict';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, publicKey, signerIdentity, some } from '@metaplex-foundation/umi';
import { mplCore, updateV1 } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, mintV1 } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { policy } from '../prepare.mjs';

const forbidden = () => { throw Error('LIFECYCLE_OFFLINE_ONLY'); };
function signer(address) {
  return Object.freeze({ ...createNoopSigner(publicKey(address)), signMessage: forbidden,
    signTransaction: forbidden, signAllTransactions: forbidden });
}
function context(address) {
  const umi = createUmi('http://127.0.0.1:1', { fetch: forbidden })
    .use(mplCore()).use(mplCandyMachine()).use(signerIdentity(signer(address)));
  const programs = umi.programs;
  umi.programs = { ...programs, get: id => programs.get(id, '*'),
    getPublicKey: (id, fallback) => programs.getPublicKey(id, fallback, '*'),
    has: id => programs.has(id, '*'), all: () => programs.all('*') };
  umi.rpc = new Proxy({}, { get: forbidden }); umi.http = new Proxy({}, { get: forbidden });
  umi.eddsa = new Proxy(umi.eddsa, { get(target, property) {
    if (['generateKeypair', 'createKeypairFromSecretKey', 'createKeypairFromSeed', 'sign'].includes(property)) return forbidden;
    return Reflect.get(target, property);
  } });
  return umi;
}
function bytes(umi, builder, blockhash) {
  const tx = builder.useV0().setFeePayer(umi.identity)
    .setBlockhash({ blockhash, lastValidBlockHeight: 1 }).build(umi);
  assert.ok(Object.values(tx.signatures).every(s => s.every(b => b === 0)), 'Unexpected signature');
  return umi.transactions.serialize(tx);
}

export function syntheticRevealMetadata(index, uriBytes) {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < policy.supply, 'Invalid synthetic index');
  assert.ok(Number.isSafeInteger(uriBytes) && uriBytes >= 40 && uriBytes <= 200, 'Invalid synthetic URI length');
  const suffix = `${String(index).padStart(4, '0')}.json`, prefix = 'https://example.invalid/';
  const uri = prefix + 'x'.repeat(uriBytes - prefix.length - suffix.length) + suffix;
  return { name: policy.revealedName.replace('{index:04d}', String(index).padStart(4, '0')), uri };
}

export function sponsoredMintTemplate({ payer, asset, roles, blockhash }) {
  assert.notEqual(payer, policy.owner, 'Sponsored probe needs distinct payer and authorized minter');
  const umi = context(payer);
  return bytes(umi, setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
    candyMachine: publicKey(roles.machine), candyGuard: publicKey(roles.guard),
    collection: publicKey(roles.collection), payer: umi.identity, minter: signer(policy.owner),
    owner: umi.identity.publicKey, asset: signer(asset),
    mintArgs: { solPayment: { destination: publicKey(policy.owner) } },
  })), blockhash);
}

export function syntheticRevealTemplate({ asset, collection, index, uriBytes, blockhash }) {
  const umi = context(policy.owner), metadata = syntheticRevealMetadata(index, uriBytes);
  return bytes(umi, updateV1(umi, { asset: publicKey(asset), collection: publicKey(collection),
    payer: umi.identity, authority: umi.identity, newName: some(metadata.name), newUri: some(metadata.uri),
  }), blockhash);
}
