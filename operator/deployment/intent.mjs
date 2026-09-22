// Bind a generic journal manifest to the complete current CoolBears policy.
// Rebuilding checks the actual instruction bytes as well as expected effects.
// This is offline intent validation, not a fresh rent, network or account check.
import assert from 'node:assert/strict';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from './plan.mjs';

export async function validateCanonicalDeploymentManifest(manifest) {
  try {
    // Snapshot all caller input before the first await; reject values that a
    // persisted JSON manifest could not faithfully represent.
    const candidate = JSON.parse(JSON.stringify(manifest));
    assert.deepEqual(candidate, manifest);
    assert.deepEqual(Object.keys(candidate).sort(), ['cluster', 'id', 'owner', 'steps', 'version']);
    assert.equal(candidate.version, 1);
    assert.equal(candidate.owner, policy.owner);
    assert.ok(Array.isArray(candidate.steps) && candidate.steps.length >= 3 && candidate.steps.length <= 20000);
    const [collection, reserve, machine] = candidate.steps;
    assert.deepEqual([collection.id, reserve.id, machine.id], ['collection-create', 'reserve-create', 'machine-create']);
    const plan = await buildDeploymentPlan({
      cluster: candidate.cluster,
      collection: collection.expected.collection,
      reservedAsset: reserve.expected.asset,
      machine: machine.expected.machine,
      blockhash: collection.blockhash,
      lastValidBlockHeight: collection.lastValidBlockHeight,
      machineRentLamports: machine.expected.machineRentLamports,
    });
    // Includes every insertion range, every required signer, zero signatures,
    // dependencies and all expected fields; hashes alone are not intent proof.
    assert.deepEqual(deploymentManifestFromPlan(candidate.id, plan), candidate);
    return plan;
  } catch {
    // Never reflect malformed URLs, arbitrary expected fields, transaction
    // payloads or accidentally pasted credentials in an error/report.
    throw Object.assign(Error('Deployment manifest does not match the approved CoolBears plan.'), {
      code: 'DEPLOYMENT_INTENT_INVALID',
    });
  }
}
