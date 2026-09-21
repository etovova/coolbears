// Read-only acceptance of the EXACT browser mint builder against real Devnet.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createNoopSigner, generateSigner, publicKey } from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { mintV1 } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { createClient, prepareMint } from '../devnet/core.mjs';
import { settings as S } from '../devnet/settings.mjs';
import { curlFetch } from './curl-transport.mjs';

assert.ok(!process.env.COOLBEARS_LAB_OPERATION, 'Read-only check');
const fixtures = {};
const client = createClient(async (url, options) => {
  const body = JSON.parse(options.body);
  assert.notEqual(body.method, 'sendTransaction');
  const response = await curlFetch(url, options);
  const text = await response.text();
  if (response.ok && body.method !== 'simulateTransaction') fixtures[body.method] = JSON.parse(text).result;
  return new Response(text, { status: response.status, headers: response.headers });
});
const prepared = await prepareMint(client, S.owner);
const umi = client.umi;
const unauthorized = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
  candyMachine: publicKey(S.machine), candyGuard: publicKey(S.guard), collection: publicKey(S.collection),
  asset: generateSigner(umi), owner: publicKey(S.owner), minter: createNoopSigner(publicKey(S.laboratory)),
  mintArgs: { solPayment: { destination: publicKey(S.owner) } },
})).setBlockhash(await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' })).buildAndSign(umi);
const negative = await client.rpc('simulateTransaction', [base64.deserialize(umi.transactions.serialize(unauthorized))[0], { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
assert.ok(negative.value.err);
assert.ok(negative.value.logs.some(line => line.includes('AddressNotAuthorized')));
const report = {
  checkedAt: new Date().toISOString(), cluster: 'devnet', production: false,
  machine: S.machine, collection: S.collection, owner: S.owner,
  positive: { err: prepared.simulation.err, unitsConsumed: prepared.simulation.unitsConsumed, logs: prepared.simulation.logs },
  unauthorized: { err: negative.value.err, logs: negative.value.logs },
  ownerBalanceLamports: fixtures.getBalance.value,
  serializedTransactionBytes: prepared.bytes.length,
  ownerSignatureVerified: false, simulationSignatureVerification: false,
  transactionsSent: 0, physicalWalletVerified: false,
};
await mkdir('tests/fixtures', { recursive: true });
await writeFile('tests/fixtures/devnet-rpc.json', JSON.stringify(fixtures, null, 2) + '\n');
await writeFile('operator/reports/wallet-test-preflight.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, positive: { ...report.positive, logs: undefined }, unauthorized: { ...report.unauthorized, logs: undefined } }));
