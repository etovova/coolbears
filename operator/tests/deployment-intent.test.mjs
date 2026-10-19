// Full current-policy intent checks using real SDK templates, entirely offline.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from '../deployment/plan.mjs';
import { validateCanonicalDeploymentManifest } from '../deployment/intent.mjs';

const address = byte => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const input = { cluster: 'devnet', collection: address(41), reservedAsset: address(42),
  machine: address(43), blockhash: address(44), lastValidBlockHeight: 1000, machineRentLamports: '5000000000' };
let manifest, previousFetch, fetchCalls = 0;

before(async () => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw Error('Network forbidden in intent validation'); };
  manifest = deploymentManifestFromPlan('canonical-intent-fixture', await buildDeploymentPlan(input));
});
after(() => { globalThis.fetch = previousFetch; assert.equal(fetchCalls, 0); });

async function rejectsChange(change) {
  const candidate = structuredClone(manifest);
  change(candidate);
  await assert.rejects(validateCanonicalDeploymentManifest(candidate), error => {
    assert.equal(error.code, 'DEPLOYMENT_INTENT_INVALID');
    assert.equal(error.message, 'Deployment manifest does not match the approved CoolBears plan.');
    return true;
  });
}

test('validates all 1431 current-policy templates while retaining offline readiness limits', async () => {
  const plan = await validateCanonicalDeploymentManifest(manifest);
  assert.equal(plan.steps.length, 1431);
  assert.equal(plan.machineItems, 9999);
  assert.equal(plan.reservedItems, 1);
  assert.equal(plan.roles.owner, policy.owner);
  assert.deepEqual(deploymentManifestFromPlan(manifest.id, plan), manifest);
  for (const field of ['readyToSubmit', 'networkVerified', 'blockhashVerified', 'rentVerified', 'salesOpen']) {
    assert.equal(plan[field], false);
  }
  assert.equal(plan.feeQuote, null);
  assert.equal(fetchCalls, 0);
});

test('rejects expected effects detached from the actual collection instruction', async () => {
  await rejectsChange(candidate => { candidate.steps[0].expected.royaltyBasisPoints = 0; });
});

test('rejects a consistent transfer message and hash disguised as collection creation', async () => {
  await rejectsChange(candidate => {
    const owner = new PublicKey(policy.owner);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner,
      recentBlockhash: candidate.steps[0].blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(address(90)), lamports: 1 })],
    }).compileToV0Message());
    Object.assign(candidate.steps[0], {
      transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      messageSha256: createHash('sha256').update(tx.message.serialize()).digest('hex'),
      requiredSigners: [policy.owner],
    });
  });
});

test('rejects an omitted final insertion batch and a changed late metadata range', async () => {
  await rejectsChange(candidate => { candidate.steps.pop(); });
  await rejectsChange(candidate => {
    candidate.steps.at(-1).expected.configLines[0].uri = `${policy.website}/metadata/hidden/0000.json`;
  });
});

test('rejects a different owner or redirected payment even when expected fields look valid', async () => {
  await rejectsChange(candidate => { candidate.owner = address(91); });
  await rejectsChange(candidate => { candidate.steps[2].expected.payment.destination = address(91); });
});

test('rejects a rent declaration that differs from encoded account-allocation lamports', async () => {
  await rejectsChange(candidate => { candidate.steps[2].expected.machineRentLamports = '1'; });
});

test('does not allow per-step hash changes or pre-existing signatures in an immutable unsigned template', async () => {
  await rejectsChange(candidate => { candidate.steps[3].messageSha256 = 'a'.repeat(64); });
  await rejectsChange(candidate => {
    const tx = VersionedTransaction.deserialize(Buffer.from(candidate.steps[0].transactionBase64, 'base64'));
    tx.signatures[0][0] = 1;
    candidate.steps[0].transactionBase64 = Buffer.from(tx.serialize()).toString('base64');
  });
});

test('malformed input errors never reflect supplied values or internal assertion differences', async () => {
  const marker = 'DO_NOT_EXPOSE_SYNTHETIC_CREDENTIAL';
  const candidate = structuredClone(manifest);
  candidate.steps[0].expected.collection = marker;
  await assert.rejects(validateCanonicalDeploymentManifest(candidate), error => {
    assert.equal(error.code, 'DEPLOYMENT_INTENT_INVALID');
    assert.ok(!String(error).includes(marker));
    assert.equal(error.cause, undefined);
    return true;
  });
  for (const value of [null, undefined, {}, { ...manifest, unexpected: true }]) {
    await assert.rejects(validateCanonicalDeploymentManifest(value), { code: 'DEPLOYMENT_INTENT_INVALID' });
  }
});
