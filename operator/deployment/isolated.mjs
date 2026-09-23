// Stateful execution in an in-memory VM. No RPC, wallet, faucet or journal.
// LiteSVM.sendTransaction commits ONLY to this process's artificial bank.
import { createHash } from 'node:crypto';
import { LiteSVM, Rent, Clock, FailedTransactionMetadata } from 'litesvm';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getCandyMachineSize } from '@metaplex-foundation/mpl-core-candy-machine';
import { makePreparation, policy } from '../prepare.mjs';
import { buildDeploymentPlan, deploymentManifestFromPlan } from './plan.mjs';
import { buildDeploymentCostModel } from './cost-model.mjs';
import { checkDeploymentState, requireDeploymentCheck as need } from './read.mjs';
import { bytesHash, decodeIsolatedSnapshot } from './isolated-snapshot.mjs';
import { formatSol } from './budget.mjs';
import svmPackage from '../node_modules/litesvm/package.json' with { type: 'json' };

const INITIAL_BALANCE = 20_000_000_000n; // Artificial test funds, never real SOL.
const SYSTEM = '11111111111111111111111111111111';

function placeholder(label, sourceHash) {
  for (let i = 0; i < 1000; i++) {
    const bytes = createHash('sha256').update(`coolbears-isolated:${sourceHash}:${label}:${i}`).digest();
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58();
  }
  throw Error('ISOLATED_PUBLIC_ADDRESS_UNAVAILABLE');
}

export function unsignedVmTransaction(transactionBase64) {
  const bytes = Buffer.from(transactionBase64, 'base64');
  need(bytes.length <= 1232 && bytes.toString('base64') === transactionBase64, 'INVALID_ISOLATED_TRANSACTION');
  const tx = VersionedTransaction.deserialize(bytes);
  need(tx.version === 0 && tx.message.addressTableLookups.length === 0
    && tx.signatures.every(s => s.every(byte => byte === 0)), 'ISOLATED_REQUIRES_UNSIGNED_TEMPLATE');
  need(Buffer.from(tx.serialize()).equals(bytes), 'ISOLATED_TRANSACTION_ENCODING_CHANGED');
  // Kit's public transaction representation, preserving every message byte.
  return { tx, vmTransaction: { messageBytes: tx.message.serialize(),
    signatures: Object.fromEntries(tx.message.staticAccountKeys.slice(0, tx.signatures.length)
      .map((key, i) => [key.toBase58(), tx.signatures[i]])) } };
}

function localAccount(svm, address) {
  const account = svm.getAccount(address);
  if (!account.exists) return null;
  need(account.lamports <= BigInt(Number.MAX_SAFE_INTEGER), 'UNSAFE_ISOLATED_BALANCE');
  return { owner: account.programAddress, executable: account.executable, lamports: Number(account.lamports),
    data: [Buffer.from(account.data).toString('base64'), 'base64'], space: account.data.length };
}

export async function runIsolatedDeployment({ snapshot, onProgress = () => {}, retainVm = false } = {}) {
  need(svmPackage.version === '1.4.1', 'ISOLATED_RUNTIME_VERSION_CHANGED');
  need(typeof onProgress === 'function', 'INVALID_ISOLATED_OPTIONS');
  need(typeof retainVm === 'boolean', 'INVALID_ISOLATED_OPTIONS');
  const source = decodeIsolatedSnapshot(snapshot);
  const snapshotSha256 = bytesHash(Buffer.from(JSON.stringify(snapshot)));
  const report = { version: 1, kind: 'isolated-devnet-deployment', status: 'running',
    startedAt: new Date().toISOString(), environment: 'LiteSVM-in-memory', litesvmVersion: svmPackage.version,
    sourceCluster: 'devnet', sourceSlot: source.slot, snapshotSha256, sourceCapturedAt: snapshot.capturedAt,
    programs: source.programs.map(({ elf, ...info }) => info), rent: source.rent, clock: source.clock,
    rentSha256: source.rentSha256, clockSha256: source.clockSha256,
    signaturesVerified: false, blockhashChecked: true, blockhashScope: 'local-VM-only',
    transactionHistoryCapacity: 0, featureSet: 'LiteSVM-default-not-cluster-feature-parity',
    runtimeMatchesDevnetValidator: false, realTransactionsSent: 0, transactionsSent: 0,
    realLamportsSpent: '0', ownerWalletUsed: false, productionBundleCreated: false,
    keysCreated: 0, signaturesCreated: 0, journalWrites: 0, readyToSubmit: false, salesOpen: false,
    mintPriceLamports: String(policy.priceSol * 1e9), addressesArePlaceholders: true,
    budgetComplete: false, fundingRecommendationLamports: null,
    wholeDeploymentSimulated: false, wholeDeploymentSimulatedOnChain: false,
    finalStateVerified: false, completedMessages: 0, steps: [], accountCheckpoints: [] };
  // All signatures are zero, so disable the duplicate-signature cache. Blockhash
  // checking stays ON; no live blockhash or signed production bytes are used.
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
  svm.setRent(new Rent(BigInt(source.rent.lamportsPerByteYear), source.rent.exemptionThreshold, source.rent.burnPercent));
  const c = source.clock;
  svm.setClock(new Clock(BigInt(c.slot), BigInt(c.epochStartTimestamp), BigInt(c.epoch),
    BigInt(c.leaderScheduleEpoch), BigInt(c.unixTimestamp)));
  for (const program of source.programs) svm.addProgram(program.address, program.elf);
  const config = makePreparation().cmConfig.config;
  const machineSize = getCandyMachineSize(config.itemsAvailable, config.configLineSettings);
  const plan = await buildDeploymentPlan({ cluster: 'devnet', collection: placeholder('collection', snapshotSha256),
    reservedAsset: placeholder('reserve', snapshotSha256), machine: placeholder('machine', snapshotSha256),
    blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1,
    machineRentLamports: svm.minimumBalanceForRentExemption(BigInt(machineSize)).toString() });
  const { model } = await buildDeploymentCostModel(deploymentManifestFromPlan('isolated-devnet', plan));
  report.model = model; report.placeholderAddresses = plan.roles; report.plannedMessages = plan.steps.length;
  report.initialArtificialBalanceLamports = INITIAL_BALANCE.toString();
  svm.setAccount({ address: policy.owner, lamports: INITIAL_BALANCE,
    data: new Uint8Array(), programAddress: SYSTEM, executable: false });
  const adapter = { async call(method, [addresses]) {
    need(method === 'getMultipleAccounts', 'ISOLATED_ADAPTER_READ_ONLY');
    return { context: { slot: source.slot }, value: addresses.map(a => localAccount(svm, a)) };
  } };
  await checkDeploymentState(adapter, plan, -1);
  const roles = ['collection', 'reservedAsset', 'machine', 'guard'];
  const accountSummary = () => roles.map(role => {
    const address = plan.roles[role], account = svm.getAccount(address);
    if (!account.exists) return { role, address, exists: false };
    return { role, address, exists: true, bytes: account.data.length, owner: account.programAddress,
      lamports: account.lamports.toString(), rentLamports: svm.minimumBalanceForRentExemption(BigInt(account.data.length)).toString(),
      dataSha256: bytesHash(account.data) };
  });
  const rentBySize = new Map(Object.values(model.sizes).map(size => [size, svm.minimumBalanceForRentExemption(BigInt(size))]));
  let fees = 0n, rent = 0n, protocol = 0n, total = 0n;
  const started = performance.now();
  for (const [index, step] of plan.steps.entries()) {
    need(performance.now() - started < 120000, 'ISOLATED_EXECUTION_DEADLINE');
    const { tx, vmTransaction } = unsignedVmTransaction(step.transactionBase64);
    need(bytesHash(vmTransaction.messageBytes) === step.messageSha256, 'ISOLATED_MESSAGE_CHANGED');
    const writable = tx.message.staticAccountKeys.filter((_, i) => tx.message.isAccountWritable(i)).map(key => key.toBase58());
    const before = writable.map(a => svm.getBalance(a) ?? 0n);
    const payerBefore = svm.getBalance(policy.owner);
    const result = svm.sendTransaction(vmTransaction);
    if (result instanceof FailedTransactionMetadata) {
      report.status = 'blocked'; report.failedStepId = step.id; report.code = 'ISOLATED_PROGRAM_EXECUTION_FAILED';
      // Bounded VM diagnostics, never arbitrary provider errors or URLs.
      report.failure = { error: result.err().toString().slice(0, 200),
        logs: result.meta().logs().slice(-12).map(line => line.slice(0, 300)) };
      report.completedAt = new Date().toISOString();
      return { report, plan };
    }
    const after = writable.map(a => svm.getBalance(a) ?? 0n);
    // Conservation across every writable tx account separates runtime fees
    // from rent and the Core protocol charge held in the asset account.
    const fee = before.reduce((a, b) => a + b, 0n) - after.reduce((a, b) => a + b, 0n);
    const debit = payerBefore - svm.getBalance(policy.owner);
    const rentForStep = model.rentItems.filter(x => x.stepId === step.id)
      .reduce((n, x) => n + rentBySize.get(x.bytes) - (x.subtractBytes ? rentBySize.get(x.subtractBytes) : 0n), 0n);
    const expectedProtocol = model.protocolItems.filter(x => x.stepId === step.id).reduce((n, x) => n + BigInt(x.lamports), 0n);
    const actualProtocol = debit - fee - rentForStep;
    need(fee > 0n && actualProtocol === expectedProtocol, 'ISOLATED_COST_MODEL_MISMATCH');
    fees += fee; rent += rentForStep; protocol += actualProtocol; total += debit;
    report.steps.push({ id: step.id, messageSha256: step.messageSha256,
      requiredSignatures: tx.signatures.length, computeUnits: result.computeUnitsConsumed().toString(),
      payerDebitLamports: debit.toString(), feeLamports: fee.toString(), rentLamports: rentForStep.toString(),
      protocolLamports: actualProtocol.toString() });
    report.completedMessages++;
    if (index < 3 || index === plan.steps.length - 1) {
      await checkDeploymentState(adapter, plan, index);
      const accounts = accountSummary();
      for (const account of accounts.filter(a => a.exists)) {
        const size = account.role === 'collection'
          ? (index < 2 ? model.sizes.collection : model.sizes.collectionWithDelegate) : model.sizes[account.role];
        need(account.bytes === size, 'ISOLATED_ACCOUNT_SIZE_MISMATCH');
      }
      report.accountCheckpoints.push({ afterStep: step.id, accounts });
    }
    if (index < 3 || (index + 1) % 200 === 0 || index === plan.steps.length - 1) {
      onProgress({ completedMessages: index + 1, plannedMessages: plan.steps.length, lastStep: step.id });
    }
  }
  const final = accountSummary();
  const actualSizes = Object.fromEntries(final.map(a => [a.role, a.bytes]));
  need(actualSizes.collection === model.sizes.collectionWithDelegate && actualSizes.reservedAsset === model.sizes.reservedAsset
    && actualSizes.machine === model.sizes.machine && actualSizes.guard === model.sizes.guard, 'ISOLATED_ACCOUNT_SIZE_MISMATCH');
  const actualRent = final.reduce((n, a) => n + BigInt(a.rentLamports), 0n);
  const accountLamports = final.reduce((n, a) => n + BigInt(a.lamports), 0n);
  need(actualRent === rent && accountLamports === rent + protocol && INITIAL_BALANCE - svm.getBalance(policy.owner) === total
    && total === rent + protocol + fees, 'ISOLATED_BALANCE_MISMATCH');
  report.finalAccounts = final; report.actualSizes = actualSizes;
  report.finalStateVerified = true; report.wholeDeploymentSimulated = true;
  report.configLinesVerified = plan.machineItems; report.itemsRedeemed = 0;
  report.localRentQuotes = [...rentBySize].map(([bytes, lamports]) => ({ bytes, lamports: lamports.toString() }));
  report.observed = { accountRentLamports: rent.toString(), protocolLamports: protocol.toString(),
    runtimeFeesLamports: fees.toString(), payerDebitLamports: total.toString(), payerDebitSol: formatSol(total),
    protocolFeeLocation: 'reserved-asset-balance-above-rent', modelMatched: true };
  report.status = 'isolated-passed'; report.completedAt = new Date().toISOString();
  // Opt-in reuse by subsequent LOCAL cost scenarios; never exposed by the CLI.
  return { report, plan, ...(retainVm ? { svm } : {}) };
}
