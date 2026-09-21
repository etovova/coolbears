// Read-only Devnet rent quote. No estimates are presented as the total release cost.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCandyMachineSize } from '@metaplex-foundation/mpl-core-candy-machine';
import { checkRpc, validateEndpoint } from './preflight.mjs';
import { makePreparation } from './prepare.mjs';

export async function quoteMachine(endpoint) {
  validateEndpoint(endpoint);
  const preflight = await checkRpc({ endpoint });
  assert.equal(preflight.status, 'read-path-passed', `RPC preflight blocked: ${preflight.code}`);
  const { config } = makePreparation().cmConfig;
  const accountBytes = getCandyMachineSize(config.itemsAvailable, config.configLineSettings);
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [accountBytes, { commitment: 'finalized' }] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Rent quote HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.ok(!body.error, `Rent quote RPC error ${body.error?.code}`);
  assert.ok(Number.isSafeInteger(body.result) && body.result > 0, 'Invalid rent quote');
  const result = {
    checkedAt: new Date().toISOString(), cluster: 'devnet', transactionsSent: 0,
    machineItems: config.itemsAvailable, configLineSettings: config.configLineSettings,
    accountBytes, machineRentLamports: body.result, machineRentSol: body.result / 1e9,
    owner: preflight.owner, ownerBalanceLamports: preflight.balanceLamports,
    machineRentShortfallLamports: Math.max(0, body.result - preflight.balanceLamports),
    sufficientForMachineRent: preflight.balanceLamports >= body.result,
    totalReleaseCostQuoted: false,
    excluded: ['Core collection and reserved asset', 'Candy Guard account', 'creation/insertion transaction fees', 'priority fees', 'buyer mint payments and asset rent'],
  };
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await quoteMachine(process.env.COOLBEARS_RPC_URL), null, 2)); }
  catch (error) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: 'blocked', transactionsSent: 0, message: String(error.message).replaceAll(process.env.COOLBEARS_RPC_URL || '[unset]', '[RPC]') }, null, 2));
    process.exitCode = 1;
  }
}
