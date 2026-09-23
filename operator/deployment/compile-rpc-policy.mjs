// Compiled only from the canonical offline SDK plan, in the private operator environment.
import { VersionedTransaction } from '@solana/web3.js';
import { buildDeploymentCostModel } from './cost-model.mjs';
import { DeploymentRpcError } from './rpc.mjs';
import { PROGRAMS, messageIdentity, validRecoverySignature, createRequestValidator } from './request-policy.mjs';
export async function compileDeploymentRpcPolicy(manifest, { allowSimulation = false, recoverySignatures = [] } = {}) {
  if (typeof allowSimulation !== 'boolean' || !Array.isArray(recoverySignatures) || recoverySignatures.length > 20000
    || !recoverySignatures.every(validRecoverySignature)) throw new DeploymentRpcError('CONFIGURATION');
  const recovery = [...recoverySignatures];
  const { plan, model } = await buildDeploymentCostModel(manifest);
  if (plan.cluster !== 'devnet') throw new DeploymentRpcError('CLUSTER');
  const policy = { version: 1, cluster: 'devnet', owner: plan.roles.owner,
    accounts: [...PROGRAMS, plan.roles.collection, plan.roles.reservedAsset, plan.roles.machine, plan.roles.guard],
    sizes: [...new Set(Object.values(model.sizes))],
    messageIdentities: plan.steps.map(step => messageIdentity(Buffer.from(
      VersionedTransaction.deserialize(Buffer.from(step.transactionBase64, 'base64')).message.serialize()))),
    allowSimulation, recoverySignatures: recovery };
  createRequestValidator(policy);
  return policy;
}
