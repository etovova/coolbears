// Bind a generic journal manifest to the complete current CoolBears policy.
// Rebuilding checks the actual instruction bytes as well as expected effects.
// This is offline intent validation, not a fresh rent, network or account check.
import assert from 'node:assert/strict';
import { policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from './plan.mjs';
import { HIDDEN_SETTINGS, validateHiddenCommitmentSha256 } from '../storage-mode.mjs';

export async function validateCanonicalDeploymentManifest(manifest, { trustedHiddenCommitmentSha256 } = {}) {
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
    // The digest is a declared input, like the new account addresses. Rebuilding
    // proves that it is encoded in the exact approved transaction; verifying the
    // actual private mapping requires the separate private commitment workflow.
    const hidden = machine.expected.storageMode === HIDDEN_SETTINGS;
    assert.ok(machine.expected.storageMode === undefined || hidden);
    if (hidden) {
      assert.equal(candidate.steps.length, 3);
      assert.equal(machine.expected.configLineSettings, null);
    } else {
      // Explicit incompatible profiles cannot trigger a legacy rebuild. This
      // also bounds malformed-input work before any SDK construction.
      assert.equal(machine.expected.hiddenSettings, undefined);
      assert.ok(machine.expected.configLineSettings && candidate.steps.length > 3);
    }
    const hiddenCommitmentSha256 = hidden ? validateHiddenCommitmentSha256(machine.expected.hiddenSettings.hash) : undefined;
    if (trustedHiddenCommitmentSha256 !== undefined) {
      assert.equal(validateHiddenCommitmentSha256(trustedHiddenCommitmentSha256), hiddenCommitmentSha256);
    }
    const plan = await buildDeploymentPlan({
      cluster: candidate.cluster,
      collection: collection.expected.collection,
      reservedAsset: reserve.expected.asset,
      machine: machine.expected.machine,
      blockhash: collection.blockhash,
      lastValidBlockHeight: collection.lastValidBlockHeight,
      machineRentLamports: machine.expected.machineRentLamports,
      ...(hidden ? { storageMode: HIDDEN_SETTINGS, hiddenCommitmentSha256 } : {}),
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
