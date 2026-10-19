// Runs ONLY inside PR26's artificial bank, with its original closed Guard.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getCandyMachineAccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { runIsolatedDeployment, unsignedVmTransaction } from '../deployment/isolated.mjs';
import { requireDeploymentCheck as need } from '../deployment/read.mjs';
import { bytesHash } from '../deployment/isolated-snapshot.mjs';
import { createOrder } from '../orders/journal.mjs';
import { buildOrderTransactions } from '../orders/transactions.mjs';
import { policy } from '../prepare.mjs';
import { buyerCost, revealCost, priorityFeeLamports, ownerChainScenario } from './model.mjs';
import { sponsoredMintTemplate, syntheticRevealTemplate, syntheticRevealMetadata } from './templates.mjs';
import services from './services.json' with { type: 'json' };

const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const SYSTEM = '11111111111111111111111111111111';
const PROTOCOL = 1500000n; // Expected charge; independently measured below.
const assetSerializer = getAssetV1AccountDataSerializer();
const collectionSerializer = getCollectionV1AccountDataSerializer();
const machineSerializer = getCandyMachineAccountDataSerializer();
const equalBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

function placeholder(label, hash) {
  for (let i = 0; i < 1000; i++) {
    const data = createHash('sha256').update(`coolbears-lifecycle:${hash}:${label}:${i}`).digest();
    if (PublicKey.isOnCurve(data)) return new PublicKey(data).toBase58();
  }
  throw Error('LIFECYCLE_PUBLIC_ADDRESS_UNAVAILABLE');
}
function assetData(account, owner, collection) {
  need(account.exists && account.programAddress === CORE && !account.executable, 'LIFECYCLE_ASSET_MISSING');
  const [data, end] = assetSerializer.deserialize(account.data);
  need(end === account.data.length && equalBytes(assetSerializer.serialize(data), account.data)
    && data.key === 1 && data.owner === owner && data.updateAuthority.__kind === 'Collection'
    && data.updateAuthority.fields[0] === collection && data.seq.__option === 'None', 'LIFECYCLE_ASSET_STATE');
  return data;
}
function hiddenIndex(data) {
  const match = /\/metadata\/hidden\/(\d{4})\.json$/.exec(data.uri), index = match ? Number(match[1]) : 0;
  need(index > 0 && index < policy.supply && data.uri === `${policy.website}/metadata/hidden/${match[1]}.json`
    && data.name === policy.hiddenName.replace('{index:04d}', match[1]), 'LIFECYCLE_HIDDEN_METADATA');
  return index;
}

export async function runLifecycleCosts({ snapshot, onProgress = () => {} } = {}) {
  need(typeof onProgress === 'function', 'INVALID_LIFECYCLE_OPTIONS');
  const { report: preparation, plan, svm } = await runIsolatedDeployment({ snapshot, onProgress, retainVm: true });
  need(preparation.status === 'isolated-passed' && svm, 'LIFECYCLE_PREPARATION_FAILED');
  const { roles } = plan, block = { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1 };
  const address = label => placeholder(label, preparation.snapshotSha256);
  const outsider = address('payer'), absentAsset = address('blocked-asset');
  svm.setAccount({ address: outsider, lamports: 20_000_000_000n, data: new Uint8Array(), programAddress: SYSTEM, executable: false });
  const report = { version: 1, kind: 'isolated-lifecycle-costs', status: 'running',
    startedAt: preparation.startedAt, sourceCapturedAt: preparation.sourceCapturedAt,
    sourceCluster: 'devnet', sourceSlot: preparation.sourceSlot, snapshotSha256: preparation.snapshotSha256,
    programs: preparation.programs, rent: preparation.rent, rentSha256: preparation.rentSha256,
    clockSha256: preparation.clockSha256, environment: preparation.environment, litesvmVersion: preparation.litesvmVersion,
    signaturesVerified: false, keysCreated: 0, signaturesCreated: 0, ownerWalletUsed: false,
    blockhashScope: 'local-VM-only', blockhashChecked: true, transactionHistoryCapacity: 0,
    featureSet: preparation.featureSet, runtimeMatchesDevnetValidator: false,
    realTransactionsSent: 0, transactionsSent: 0, realLamportsSpent: '0', productionBundleCreated: false,
    salesOpen: false, readyToSubmit: false, budgetComplete: false, fundingRecommendationLamports: null,
    preparation: { messages: preparation.completedMessages, configLinesVerified: preparation.configLinesVerified,
      finalStateVerified: preparation.finalStateVerified,
      accountRentLamports: preparation.observed.accountRentLamports,
      protocolLamports: preparation.observed.protocolLamports,
      runtimeFeesLamports: preparation.observed.runtimeFeesLamports,
      payerDebitLamports: preparation.observed.payerDebitLamports },
    services, mintPriceLamports: String(policy.priceSol * 1e9),
    priorityFeesIncludedInExecution: false, sampleMints: [], revealScenarios: [] };
  const calibrationMessages = [], localRent = new Map();
  const rentAt = bytes => {
    const rent = svm.minimumBalanceForRentExemption(BigInt(bytes)); localRent.set(bytes, rent); return rent;
  };
  function execute(unsignedBytes, payer) {
    const { tx, vmTransaction } = unsignedVmTransaction(Buffer.from(unsignedBytes).toString('base64'));
    need(tx.message.staticAccountKeys[0].toBase58() === payer, 'LIFECYCLE_WRONG_FEE_PAYER');
    const keys = tx.message.staticAccountKeys.filter((_, i) => tx.message.isAccountWritable(i)).map(k => k.toBase58());
    const before = keys.map(k => svm.getBalance(k) ?? 0n), payerBefore = svm.getBalance(payer);
    const result = svm.sendTransaction(vmTransaction); // in-memory bank only
    const after = keys.map(k => svm.getBalance(k) ?? 0n);
    const fee = before.reduce((a, b) => a + b, 0n) - after.reduce((a, b) => a + b, 0n);
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    const row = { messageSha256: bytesHash(vmTransaction.messageBytes), requiredSignatures: tx.signatures.length,
      computeUnits: meta.computeUnitsConsumed().toString(), feeLamports: fee.toString(),
      payerDebitLamports: (payerBefore - svm.getBalance(payer)).toString() };
    need(fee === BigInt(tx.signatures.length) * 5000n, 'LIFECYCLE_RUNTIME_FEE_CHANGED');
    return { row, failed, result };
  }
  const snapshotAccounts = names => names.map(n => svm.getAccount(roles[n]));
  const immutableNames = ['machine', 'collection', 'guard'], beforeBlocked = snapshotAccounts(immutableNames);
  const guardBefore = svm.getAccount(roles.guard), collectionBefore = svm.getAccount(roles.collection);
  const machineBefore = svm.getAccount(roles.machine), treasuryBefore = svm.getBalance(policy.owner);
  function order(buyer, assets, id) {
    return buildOrderTransactions(createOrder({ id, cluster: 'devnet', buyer,
      machine: roles.machine, collection: roles.collection, guard: roles.guard,
      quantity: assets.length, available: policy.supply - 1, assets }), block);
  }
  const blockedBytes = order(outsider, [absentAsset], 'lifecycle-closed').templates[0].unsignedBytes;
  const blocked = execute(blockedBytes, outsider);
  need(blocked.failed && blocked.result.err().index === 1 && blocked.result.err().err().code === 6033,
    'LIFECYCLE_PUBLIC_MINT_NOT_BLOCKED_BY_ADDRESS_GATE');
  need(!svm.getAccount(absentAsset).exists && svm.getBalance(policy.owner) === treasuryBefore
    && blocked.row.payerDebitLamports === blocked.row.feeLamports, 'LIFECYCLE_FAILED_MINT_SIDE_EFFECT');
  for (const [i, after] of snapshotAccounts(immutableNames).entries()) {
    need(equalBytes(beforeBlocked[i].data, after.data) && beforeBlocked[i].lamports === after.lamports,
      'LIFECYCLE_FAILED_MINT_CHANGED_STATE');
  }
  report.closedGate = { ...blocked.row, errorCode: 6033, error: 'AddressNotAuthorized',
    rejected: true, assetCreated: false, priceTransferredLamports: '0', relevantAccountsUnchanged: true };
  calibrationMessages.push({ id: 'closed-public-mint', unsignedBytes: blockedBytes, feeLamports: blocked.row.feeLamports });
  onProgress({ phase: 'closed-public-mint', rejected: true });

  // Exercise the existing exact two-signature order template at its limit.
  // The allowed minter is also treasury: its price transfer is a self-payment.
  const assets = Array.from({ length: policy.maxPerOrder }, (_, i) => address(`sample-${i}`));
  const templates = order(policy.owner, assets, 'lifecycle-sample').templates, seen = new Set(), samples = [];
  for (const [i, template] of templates.entries()) {
    const result = execute(template.unsignedBytes, policy.owner);
    need(!result.failed && result.row.requiredSignatures === 2, 'LIFECYCLE_SAMPLE_MINT_FAILED');
    const account = svm.getAccount(template.asset), data = assetData(account, policy.owner, roles.collection), index = hiddenIndex(data);
    need(!seen.has(index), 'LIFECYCLE_DUPLICATE_METADATA'); seen.add(index);
    const rent = rentAt(account.data.length), protocol = account.lamports - rent;
    need(account.data.length === 158 && protocol === PROTOCOL
      && BigInt(result.row.payerDebitLamports) === account.lamports + BigInt(result.row.feeLamports), 'LIFECYCLE_MINT_COST_MISMATCH');
    report.sampleMints.push({ sample: i + 1, ...result.row, assetBytes: account.data.length,
      rentLamports: rent.toString(), protocolLamports: protocol.toString() });
    samples.push({ address: template.asset, data, index, owner: policy.owner });
  }
  report.standardMint = { samples: samples.length, exactOrderTemplateUsed: true, allHiddenMetadataValidated: true,
    sampleMetadataDistinct: true, payerEqualsTreasury: true, priceTransferNetLamports: '0',
    rentLamports: report.sampleMints[0].rentLamports, protocolLamports: PROTOCOL.toString(), baseFeeLamports: '10000',
    overheadLamports: report.sampleMints[0].payerDebitLamports,
    publicBuyerTotalIsProjection: true, entireSupplyMinted: false };
  calibrationMessages.push({ id: 'standard-owner-mint', unsignedBytes: templates[0].unsignedBytes, feeLamports: '10000' });
  onProgress({ phase: 'standard-mint-sample', completed: samples.length });

  // Distinct payer verifies actual 0.2 SOL payment without changing Guard.
  // This legitimate sponsored shape needs one additional minter signature.
  const sponsoredAsset = address('sponsored'), sponsorBytes = sponsoredMintTemplate({ payer: outsider,
    asset: sponsoredAsset, roles, blockhash: block.blockhash });
  const sponsorTreasuryBefore = svm.getBalance(policy.owner), sponsored = execute(sponsorBytes, outsider);
  need(!sponsored.failed && sponsored.row.requiredSignatures === 3, 'LIFECYCLE_SPONSORED_MINT_FAILED');
  const sponsoredAccount = svm.getAccount(sponsoredAsset), sponsoredData = assetData(sponsoredAccount, outsider, roles.collection);
  const sponsoredIndex = hiddenIndex(sponsoredData), price = BigInt(report.mintPriceLamports);
  need(!seen.has(sponsoredIndex) && sponsoredAccount.data.length === 158 && sponsoredAccount.lamports === rentAt(158) + PROTOCOL
    && svm.getBalance(policy.owner) - sponsorTreasuryBefore === price
    && BigInt(sponsored.row.payerDebitLamports) === price + sponsoredAccount.lamports + BigInt(sponsored.row.feeLamports),
  'LIFECYCLE_SPONSORED_PAYMENT_MISMATCH');
  report.sponsoredMint = { ...sponsored.row, priceTransferredLamports: price.toString(),
    payerDifferentFromAuthorizedMinter: true, assetOwnedByPayer: true, guardChanged: false,
    extraMinterSignature: true, representsStandardPublicBuyer: false };
  calibrationMessages.push({ id: 'sponsored-mint', unsignedBytes: sponsorBytes, feeLamports: sponsored.row.feeLamports });
  const revealSamples = [{ address: sponsoredAsset, data: sponsoredData, index: sponsoredIndex, owner: outsider }, ...samples.slice(0, 3)];
  for (const [i, uriBytes] of [52, 80, 120, 200].entries()) {
    const sample = revealSamples[i], before = svm.getAccount(sample.address), oldRent = rentAt(before.data.length);
    const unsignedBytes = syntheticRevealTemplate({ asset: sample.address, collection: roles.collection,
      index: sample.index, uriBytes, blockhash: block.blockhash });
    const updated = execute(unsignedBytes, policy.owner);
    need(!updated.failed && updated.row.requiredSignatures === 1, 'LIFECYCLE_SYNTHETIC_REVEAL_FAILED');
    const after = svm.getAccount(sample.address), data = assetData(after, sample.owner, roles.collection);
    const expected = syntheticRevealMetadata(sample.index, uriBytes), newRent = rentAt(after.data.length);
    need(data.name === expected.name && data.uri === expected.uri && after.lamports - newRent === PROTOCOL
      && after.lamports - before.lamports === newRent - oldRent
      && BigInt(updated.row.payerDebitLamports) === newRent - oldRent + BigInt(updated.row.feeLamports),
    'LIFECYCLE_REVEAL_COST_MISMATCH');
    const projection = revealCost({ quantity: policy.supply, oldRentLamports: oldRent.toString(),
      newRentLamports: newRent.toString(), baseFeeLamports: updated.row.feeLamports });
    report.revealScenarios.push({ uriBytes, assetBytesBefore: before.data.length, assetBytesAfter: after.data.length,
      oldRentLamports: oldRent.toString(), newRentLamports: newRent.toString(),
      assetBalanceDeltaLamports: (after.lamports - before.lamports).toString(), ...updated.row,
      uriIsSynthetic: true, ownerUnchanged: true, collectionUnchanged: true, protocolChargePreserved: true,
      actualRevealExecuted: false, projection,
      ownerChainScenario: ownerChainScenario(preparation.observed.payerDebitLamports, projection) });
    if (i === 0) calibrationMessages.push({ id: 'synthetic-reveal', unsignedBytes, feeLamports: updated.row.feeLamports });
  }
  const guardAfter = svm.getAccount(roles.guard), collectionAfter = svm.getAccount(roles.collection), machineAfter = svm.getAccount(roles.machine);
  need(equalBytes(guardBefore.data, guardAfter.data) && guardBefore.lamports === guardAfter.lamports,
    'LIFECYCLE_GUARD_CHANGED');
  const [collectionStart, startEnd] = collectionSerializer.deserialize(collectionBefore.data);
  const [collectionEnd, endEnd] = collectionSerializer.deserialize(collectionAfter.data);
  const mintCount = samples.length + 1;
  need(collectionEnd.numMinted === collectionStart.numMinted + mintCount && collectionEnd.currentSize === collectionStart.currentSize + mintCount
    && startEnd === endEnd && equalBytes(collectionSerializer.serialize({ ...collectionEnd,
      numMinted: collectionStart.numMinted, currentSize: collectionStart.currentSize }), collectionBefore.data.slice(0, startEnd))
    && equalBytes(collectionBefore.data.slice(startEnd), collectionAfter.data.slice(endEnd))
    && collectionBefore.lamports === collectionAfter.lamports, 'LIFECYCLE_COLLECTION_CHANGED');
  const [machineStart] = machineSerializer.deserialize(machineBefore.data), [machineEnd] = machineSerializer.deserialize(machineAfter.data);
  need(machineStart.itemsRedeemed === 0n && machineEnd.itemsRedeemed === BigInt(mintCount)
    && equalBytes(machineSerializer.serialize({ ...machineEnd, itemsRedeemed: 0n }), machineSerializer.serialize(machineStart))
    && machineBefore.lamports === machineAfter.lamports && machineBefore.data.length === machineAfter.data.length,
  'LIFECYCLE_MACHINE_CHANGED');
  report.finalState = { guardUnchanged: true, guardDataSha256: bytesHash(guardAfter.data),
    collectionPolicyAndPluginsUnchanged: true, collectionMintCountIncrease: mintCount,
    machineConfigurationUnchanged: true, machineItemsRedeemed: mintCount, verified: true };
  report.buyerScenarios = [1, 10, 50].map(quantity => buyerCost({ quantity, priceLamports: report.mintPriceLamports,
    rentLamports: report.standardMint.rentLamports, protocolLamports: report.standardMint.protocolLamports, baseFeeLamports: '10000' }));
  report.priorityExamples = ['0', '1000', '10000'].map(microLamportsPerCu => ({ microLamportsPerCu,
    computeUnitLimit: 300000, additionalLamportsPerMint: priorityFeeLamports(300000, microLamportsPerCu),
    arithmeticOnly: true, currentMarketQuote: false }));
  report.retries = { automaticRetry: false, chargedFailedMintBaseFeeLamports: blocked.row.feeLamports,
    failedMintPriceChargedLamports: '0', successfulNewAttemptPaysNormalCostAgain: true,
    allFailureModesSimulated: false, unknownTransactionMustBeReconciledBeforeRetry: true };
  report.localRentQuotes = [...localRent].map(([bytes, lamports]) => ({ bytes, lamports: lamports.toString() }));
  report.revealEarliestDate = policy.earliestRevealDate;
  report.unresolved = ['Mainnet program/rent/fee calibration', 'Final metadata URI byte length and actual assets to update',
    'Priority fees and failure/contingency allowance at execution time', 'Actual service plans, usage, taxes and billing periods',
    'Commercial launch hosting choice and price', 'Production wallet/network path and signed simulation'];
  report.status = 'isolated-lifecycle-passed'; report.completedAt = new Date().toISOString();
  onProgress({ phase: 'lifecycle-complete', sampleMints: samples.length, sponsoredMints: 1, syntheticUpdates: 4 });
  return { report, calibrationMessages };
}
