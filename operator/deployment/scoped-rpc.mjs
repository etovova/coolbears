// Local operator transport; the server independently applies the same compiled policy.
import { createDeploymentRpc, GENESIS_HASHES, DeploymentRpcError } from './rpc.mjs';
import { compileDeploymentRpcPolicy } from './compile-rpc-policy.mjs';
import { createRequestValidator, jsonSnapshot } from './request-policy.mjs';
const need = (value, code) => { if (!value) throw new DeploymentRpcError(code); };
export async function createScopedDeploymentRpc({ manifest, endpoint, fetchImpl, timeoutMs,
  totalTimeoutMs, allowSimulation = false, recoverySignatures = [] } = {}) {
  const policy = await compileDeploymentRpcPolicy(manifest, { allowSimulation, recoverySignatures });
  const validate = createRequestValidator(policy);
  const rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs,
    allowSimulation, maxResponseBytes: 4 * 1024 * 1024 });
  let genesisChecked = false, checkingGenesis = null;
  async function checkGenesis() {
    if (!checkingGenesis) checkingGenesis = (async () => {
      const value = await rpc.call('getGenesisHash');
      need(value === GENESIS_HASHES.devnet, 'GENESIS');
      genesisChecked = true;
      return value;
    })().finally(() => { checkingGenesis = null; });
    return checkingGenesis;
  }
  return Object.freeze({
    get requests() { return rpc.requests; },
    get networkVerified() { return genesisChecked; },
    cluster: 'devnet', salesOpen: false, readyToSubmit: false,
    maxResponseBytes: 4 * 1024 * 1024,
    async call(method, input = []) {
      const params = jsonSnapshot(input);
      try { validate(method, params); }
      catch (error) { throw error instanceof DeploymentRpcError ? error : new DeploymentRpcError('PARAMS'); }
      if (method === 'getGenesisHash') { genesisChecked = false; return checkGenesis(); }
      if (!genesisChecked) await checkGenesis();
      return rpc.call(method, params);
    },
  });
}
