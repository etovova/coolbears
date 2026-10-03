// Compiled only from the canonical offline SDK plan, in the private operator environment.
import { VersionedTransaction } from '@solana/web3.js';
import { buildDeploymentCostModel } from './cost-model.mjs';
import { DeploymentRpcError } from './rpc.mjs';
import { networkProfile } from './network.mjs';
import { PROGRAMS, messageIdentity, validRecoverySignature, createRequestValidator } from './request-policy.mjs';
export async function compileDeploymentRpcPolicy(manifest, { allowSimulation = false, authorizeMainnet = false, recoverySignatures = [], trustedHiddenCommitmentSha256 } = {}) {
  if (typeof allowSimulation !== 'boolean' || typeof authorizeMainnet !== 'boolean' || !Array.isArray(recoverySignatures) || recoverySignatures.length > 20000
    || !recoverySignatures.every(validRecoverySignature)) throw new DeploymentRpcError('CONFIGURATION');
  const recovery = [...recoverySignatures];
  const { plan, model } = await buildDeploymentCostModel(manifest, { trustedHiddenCommitmentSha256 });
  let profile;
  try { profile = networkProfile(plan.cluster); } catch { throw new DeploymentRpcError('CLUSTER'); }
  if ((profile.cluster === 'mainnet-beta') !== authorizeMainnet) throw new DeploymentRpcError('CONFIGURATION');
  const hidden = plan.steps[2].expected.storageMode === 'hidden-settings';
  if (profile.cluster === 'mainnet-beta' && hidden
    && (typeof trustedHiddenCommitmentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(trustedHiddenCommitmentSha256)
      || trustedHiddenCommitmentSha256 === '0'.repeat(64)
      || trustedHiddenCommitmentSha256 !== plan.steps[2].expected.hiddenSettings.hash)) throw new DeploymentRpcError('CONFIGURATION');
  const policy = { version: hidden ? 2 : 1, cluster: profile.cluster, owner: plan.roles.owner,
    ...(hidden ? { storageMode: 'hidden-settings', hiddenCommitmentSha256: plan.steps[2].expected.hiddenSettings.hash } : {}),
    accounts: [...PROGRAMS, plan.roles.collection, plan.roles.reservedAsset, plan.roles.machine, plan.roles.guard],
    sizes: [...new Set(Object.values(model.sizes))],
    messageIdentities: plan.steps.map(step => messageIdentity(Buffer.from(
      VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64')).message.serialize()))),
    allowSimulation, recoverySignatures: recovery };
  createRequestValidator(policy);
  return policy;
}
