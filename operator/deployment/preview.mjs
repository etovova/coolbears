// Devnet-only planning preview without a production bundle or private keys.
// Uses disposable public placeholders, public metadata and read/simulate RPC.
// No sender, faucet, wallet, signer vault or production journal is opened.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey } from '@solana/web3.js';
import { getCandyMachineSize } from '@metaplex-foundation/mpl-core-candy-machine';
import { makePreparation, policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from './plan.mjs';
import { buildDeploymentCostModel } from './cost-model.mjs';
import { createDeploymentJournal } from './journal.mjs';
import { createDeploymentRpc, assertCluster } from './rpc.mjs';
import { rpcContext, rpcAmount, checkDeploymentState, requireDeploymentCheck as need, blockedDeploymentReport } from './read.mjs';
import { simulateDeploymentStep } from './simulation.mjs';
import { quotePreviewFeeWindows } from './preview-fees.mjs';
import { formatSol } from './budget.mjs';

function publicPlaceholder(label, nonce) {
  // Only public curve points are chosen; no seed or secret signing key is made.
  for (let n = 0; n < 1000; n++) {
    const bytes = createHash('sha256').update('coolbears-preview:' + nonce + ':' + label + ':' + n).digest();
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58();
  }
  throw Error('PREVIEW_PUBLIC_ADDRESS_UNAVAILABLE');
}

export async function previewDevnetDeployment({ endpoint, fetchImpl = (...args) => globalThis.fetch(...args), onProgress = () => {} } = {}) {
  const report = { version: 1, kind: 'devnet-deployment-planning-preview', status: 'blocked',
    cluster: 'devnet', startedAt: new Date().toISOString(), addressesArePlaceholders: true,
    productionBundleCreated: false, keysCreated: 0, signaturesCreated: 0, transactionsSent: 0,
    wholeDeploymentSimulated: false, allQuotesSimultaneouslyFresh: false,
    budgetComplete: false, fundingRecommendationLamports: null, readyToSubmit: false, salesOpen: false,
    everyMessageQuoted: false, estimates: null };
  let rpc, directory, phase = 'configuration', requests = 0, previousStart = -Infinity;
  const started = performance.now();
  try {
    need(typeof fetchImpl === 'function' && typeof onProgress === 'function', 'INVALID_PREVIEW_OPTIONS');
    const pacedFetch = async (url, options) => {
      need(performance.now() - started < 18 * 60 * 1000, 'PREVIEW_DEADLINE_EXCEEDED');
      // Public RPC documents 40 requests/method/10 seconds. One request at a
      // time and >=350ms between starts stay below this without retrying 429.
      const wait = Math.max(0, 350 - (performance.now() - previousStart));
      if (wait) await sleep(wait, undefined, { signal: options.signal });
      previousStart = performance.now(); requests++;
      return fetchImpl(url, options);
    };
    rpc = createDeploymentRpc({ endpoint, fetchImpl: pacedFetch });
    phase = 'network';
    report.genesisHash = await assertCluster(rpc, 'devnet');
    const config = makePreparation().cmConfig.config;
    const machineSpace = getCandyMachineSize(config.itemsAvailable, config.configLineSettings);
    phase = 'rent';
    const rent = rpcAmount(await rpc.call('getMinimumBalanceForRentExemption', [machineSpace, { commitment: 'finalized' }]));
    need(rent > 0n, 'INVALID_MACHINE_RENT');
    const block = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    rpcContext(block);
    const nonce = randomUUID();
    phase = 'plan';
    const plan = await buildDeploymentPlan({ cluster: 'devnet',
      collection: publicPlaceholder('collection', nonce), reservedAsset: publicPlaceholder('reserve', nonce),
      machine: publicPlaceholder('machine', nonce), blockhash: block.value?.blockhash,
      lastValidBlockHeight: block.value?.lastValidBlockHeight, machineRentLamports: rent.toString() });
    const manifest = deploymentManifestFromPlan('devnet-preview-' + nonce, plan);
    const { model } = await buildDeploymentCostModel(manifest);
    report.model = model;
    report.placeholderAddresses = { collection: plan.roles.collection, reservedAsset: plan.roles.reservedAsset,
      machine: plan.roles.machine, guard: plan.roles.guard };
    report.mintPriceLamports = String(policy.priceSol * 1e9);
    report.plannedMessages = plan.steps.length;
    phase = 'accounts';
    const accountSlot = await checkDeploymentState(rpc, plan, -1);
    phase = 'rent';
    const rentQuotes = [];
    for (const bytes of [...new Set(Object.values(model.sizes))]) {
      const amount = rpcAmount(await rpc.call('getMinimumBalanceForRentExemption', [bytes, { commitment: 'finalized' }]));
      need(amount > 0n, 'INVALID_RENT_QUOTE');
      rentQuotes.push({ bytes, lamports: amount.toString(), checkedAt: new Date().toISOString() });
    }
    need(rentQuotes.find(q => q.bytes === machineSpace)?.lamports === rent.toString(), 'MACHINE_RENT_CHANGED_REBUILD_PLAN');
    report.rentQuotes = rentQuotes;
    phase = 'simulation';
    directory = await mkdtemp(path.join(tmpdir(), 'coolbears-public-preview-'));
    const journal = path.join(directory, 'journal');
    await createDeploymentJournal(journal, manifest);
    const simulation = await simulateDeploymentStep({ directory: journal, stepId: 'collection-create',
      mode: 'unsigned', endpoint, fetchImpl: pacedFetch });
    report.simulation = { scope: 'collection-create-with-public-placeholder', status: simulation.status,
      simulationVerified: simulation.simulationVerified === true, signaturesVerified: false,
      ...(simulation.simulationVerified ? { simulationSlot: simulation.simulationSlot,
        unitsConsumed: simulation.unitsConsumed, transactionSha256: simulation.transactionSha256, checkedAt: simulation.checkedAt }
        : { phase: simulation.phase, code: simulation.code }),
      dependentStepsSimulated: 0, effectsPersisted: false };
    onProgress({ simulationStatus: report.simulation.status, quotedMessages: 0, totalMessages: plan.steps.length });
    phase = 'fees';
    report.fees = await quotePreviewFeeWindows({ plan, rpc, minimumSlot: accountSlot, onProgress });
    phase = 'network-recheck';
    await assertCluster(rpc, 'devnet');
    phase = 'rent-recheck';
    for (const quote of rentQuotes) {
      const latest = rpcAmount(await rpc.call('getMinimumBalanceForRentExemption', [quote.bytes, { commitment: 'finalized' }]));
      need(latest.toString() === quote.lamports, 'RENT_CHANGED_DURING_PREVIEW');
    }
    phase = 'accounts-recheck';
    await checkDeploymentState(rpc, plan, -1, accountSlot);
    const bySize = new Map(rentQuotes.map(q => [q.bytes, BigInt(q.lamports)]));
    const rentItems = model.rentItems.map(item => {
      const value = bySize.get(item.bytes) - (item.subtractBytes ? bySize.get(item.subtractBytes) : 0n);
      need(value > 0n, 'INVALID_RENT_GROWTH');
      return { ...item, lamports: value.toString() };
    });
    const accountRent = rentItems.reduce((n, item) => n + BigInt(item.lamports), 0n);
    const protocol = model.protocolItems.reduce((n, item) => n + BigInt(item.lamports), 0n);
    const network = BigInt(report.fees.networkFeesLamports), total = accountRent + protocol + network;
    const buffer = (total * 1000n + 9999n) / 10000n;
    const retry = BigInt(report.fees.maxNetworkFeeLamports) * 10n;
    report.rentItems = rentItems;
    report.estimates = { accountRentLamports: accountRent.toString(), protocolLamports: protocol.toString(),
      networkFeesLamports: network.toString(), fullDeploymentLamports: total.toString(), fullDeploymentSol: formatSol(total),
      bufferBasisPoints: 1000, bufferLamports: buffer.toString(), retryTransactions: 10,
      retryFeeAllowanceLamports: retry.toString(), planningScenarioLamports: (total + buffer + retry).toString(),
      planningScenarioSol: formatSol(total + buffer + retry) };
    report.assumptions = [...model.assumptions, 'public-placeholder-addresses',
      'fees-observed-in-separate-time-windows-not-one-fresh-snapshot', 'Devnet-only-not-Mainnet'];
    report.status = 'preview-estimated';
    report.everyMessageQuoted = true;
    report.rentStableAtEnd = true;
  } catch (error) {
    const blocked = blockedDeploymentReport(error, phase, rpc, 'blocked');
    report.phase = blocked.phase; report.code = blocked.code;
    report.estimates = null; report.everyMessageQuoted = false;
  } finally {
    // Only this function's own disposable preview directory is removed.
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { report.temporaryCleanupFailed = true; }
    }
    report.completedAt = new Date().toISOString();
    report.networkRequests = requests;
  }
  return report;
}
