// New hidden-profile checks against explicit historical public program copies.
// This module has no RPC capability, real-wallet signing, network send or deploy.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { getAssetV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import { getCollectionV1AccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { getCandyMachineAccountDataSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { runIsolatedDeployment, unsignedVmTransaction } from '../deployment/isolated.mjs';
import { bytesHash } from '../deployment/isolated-snapshot.mjs';
import { createOrderModel } from '../orders/journal-model.mjs';
import { createOrderPlanner } from '../orders/transaction-model.mjs';
import { sponsoredMintTemplate } from './templates.mjs';
import { policy } from '../prepare.mjs';
import { resolveHiddenIndexedMetadata } from '../storage-mode.mjs';

const PROTOCOL = 1500000n, SYSTEM = '11111111111111111111111111111111';
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const need = (condition, code) => { if (!condition) throw Error(code); };
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
function placeholder(label, snapshotHash) {
  for (let i = 0; i < 1000; i++) {
    const bytes = createHash('sha256').update(`coolbears-hidden-costs:${snapshotHash}:${label}:${i}`).digest();
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58();
  }
  throw Error('HIDDEN_VM_PLACEHOLDER_UNAVAILABLE');
}
export async function runHiddenIsolatedCosts({ snapshot, hiddenCommitmentSha256, onProgress = () => {} } = {}) {
  const { report: deployment, plan, svm } = await runIsolatedDeployment({ snapshot, storageMode: 'hidden-settings',
    hiddenCommitmentSha256, retainVm: true, onProgress });
  need(deployment.status === 'isolated-passed' && svm, 'HIDDEN_VM_DEPLOYMENT_FAILED');
  const { roles } = plan, orderModel = createOrderModel(policy, { storageMode: 'hidden-settings', hiddenCommitmentSha256 });
  const planner = createOrderPlanner(orderModel), snapshotHash = deployment.snapshotSha256;
  const buyer = placeholder('buyer', snapshotHash), absentAsset = placeholder('blocked-asset', snapshotHash);
  const block = { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1 };
  svm.setAccount({ address: buyer, lamports: 20_000_000_000n, data: new Uint8Array(), programAddress: SYSTEM, executable: false });
  const assetSerializer = getAssetV1AccountDataSerializer(), machineSerializer = getCandyMachineAccountDataSerializer();
  const collectionSerializer = getCollectionV1AccountDataSerializer();
  const report = { ...deployment, kind: 'isolated-hidden-deployment-and-mint-costs', deploymentStatus: deployment.status,
    status: 'running', historicalProgramSnapshot: true, freshMainnetQuote: false, fixtureCommitmentOnly: true,
    privateMappingVerified: false, priorityFeesIncluded: false, localSamples: [],
    sameUriReveal: { onchainUpdatesPrepared: 0, ownerOnchainRevealCostLamports: '0',
      httpRevealActuallyPerformed: false, remoteImagesVerified: false, marketplaceRefreshVerified: false,
      existingInternalAssetUpdateExcluded: true } };
  function execute(bytes, payer) {
    const { tx, vmTransaction } = unsignedVmTransaction(Buffer.from(bytes).toString('base64'));
    need(tx.message.staticAccountKeys[0].toBase58() === payer, 'HIDDEN_VM_WRONG_PAYER');
    const writable = tx.message.staticAccountKeys.filter((_, i) => tx.message.isAccountWritable(i)).map(k => k.toBase58());
    const before = writable.map(a => svm.getBalance(a) ?? 0n), payerBefore = svm.getBalance(payer);
    const result = svm.sendTransaction(vmTransaction), after = writable.map(a => svm.getBalance(a) ?? 0n);
    const fee = before.reduce((a, b) => a + b, 0n) - after.reduce((a, b) => a + b, 0n);
    const failed = result instanceof FailedTransactionMetadata, meta = failed ? result.meta() : result;
    need(fee === BigInt(tx.signatures.length) * 5000n, 'HIDDEN_VM_RUNTIME_FEE_CHANGED');
    return { failed, result, row: { messageSha256: bytesHash(vmTransaction.messageBytes),
      requiredSignatures: tx.signatures.length, computeUnits: meta.computeUnitsConsumed().toString(),
      feeLamports: fee.toString(), payerDebitLamports: (payerBefore - svm.getBalance(payer)).toString() } };
  }
  function order(buyerAddress, assets, id) {
    return planner.buildOrderTransactions(orderModel.createOrder({ id, cluster: 'devnet', buyer: buyerAddress,
      machine: roles.machine, collection: roles.collection, guard: roles.guard, quantity: assets.length,
      available: policy.supply - 1, assets }), block);
  }
  const guardBefore = svm.getAccount(roles.guard), machineBefore = svm.getAccount(roles.machine);
  const collectionBefore = svm.getAccount(roles.collection), ownerBefore = svm.getBalance(policy.owner);
  const blocked = execute(order(buyer, [absentAsset], 'hidden-vm-closed').templates[0].unsignedBytes, buyer);
  need(blocked.failed && blocked.result.err().index === 1 && blocked.result.err().err().code === 6033,
    'HIDDEN_VM_PUBLIC_MINT_NOT_BLOCKED');
  need(!svm.getAccount(absentAsset).exists && svm.getBalance(policy.owner) === ownerBefore
    && blocked.row.payerDebitLamports === blocked.row.feeLamports, 'HIDDEN_VM_FAILED_MINT_SIDE_EFFECT');
  for (const [address, before] of [[roles.guard, guardBefore], [roles.machine, machineBefore], [roles.collection, collectionBefore]]) {
    const after = svm.getAccount(address); need(same(before.data, after.data) && before.lamports === after.lamports, 'HIDDEN_VM_FAILED_MINT_STATE');
  }
  report.closedGate = { ...blocked.row, rejected: true, errorCode: 6033, assetCreated: false,
    priceTransferredLamports: '0', relevantAccountsUnchanged: true };
  const sampleAssets = Array.from({ length: policy.maxPerOrder }, (_, i) => placeholder(`asset-${i}`, snapshotHash));
  const templates = order(policy.owner, sampleAssets, 'hidden-vm-owner-samples').templates;
  function verifiedAsset(address, owner, expectedIndex) {
    const account = svm.getAccount(address); need(account.exists && account.programAddress === CORE && !account.executable, 'HIDDEN_VM_ASSET_MISSING');
    const [data, end] = assetSerializer.deserialize(account.data), expected = resolveHiddenIndexedMetadata(policy, expectedIndex);
    need(end === account.data.length && same(assetSerializer.serialize(data), account.data) && data.owner === owner
      && data.updateAuthority.__kind === 'Collection' && data.updateAuthority.fields[0] === roles.collection
      && data.name === expected.name && data.uri === expected.uri && data.seq.__option === 'None', 'HIDDEN_VM_ASSET_CHANGED');
    const rent = svm.minimumBalanceForRentExemption(BigInt(account.data.length));
    need(account.lamports === rent + PROTOCOL, 'HIDDEN_VM_PROTOCOL_CHARGE_MISMATCH');
    return { account, data, rent };
  }
  for (const [i, template] of templates.entries()) {
    const executed = execute(template.unsignedBytes, policy.owner); need(!executed.failed && executed.row.requiredSignatures === 2, 'HIDDEN_VM_SAMPLE_MINT_FAILED');
    const { account, rent } = verifiedAsset(template.asset, policy.owner, i + 1);
    need(BigInt(executed.row.payerDebitLamports) === account.lamports + BigInt(executed.row.feeLamports), 'HIDDEN_VM_SAMPLE_COST_MISMATCH');
    report.localSamples.push({ index: i + 1, ...executed.row, assetBytes: account.data.length,
      rentLamports: rent.toString(), protocolLamports: PROTOCOL.toString(), payerEqualsTreasury: true,
      priceTransferNetLamports: '0' });
  }
  const sponsoredAsset = placeholder('sponsored-asset', snapshotHash), treasuryBefore = svm.getBalance(policy.owner);
  const sponsored = execute(sponsoredMintTemplate({ payer: buyer, asset: sponsoredAsset, roles, blockhash: block.blockhash }), buyer);
  need(!sponsored.failed && sponsored.row.requiredSignatures === 3, 'HIDDEN_VM_SPONSORED_MINT_FAILED');
  const { account: minted, rent } = verifiedAsset(sponsoredAsset, buyer, sampleAssets.length + 1), price = BigInt(policy.priceSol * 1e9);
  need(svm.getBalance(policy.owner) - treasuryBefore === price
    && BigInt(sponsored.row.payerDebitLamports) === price + minted.lamports + BigInt(sponsored.row.feeLamports), 'HIDDEN_VM_BUYER_PAYMENT_MISMATCH');
  report.distinctBuyerFixture = { ...sponsored.row, priceTransferredLamports: price.toString(),
    ownerBalanceIncreaseLamports: price.toString(), assetOwnedByPayer: true, buyerPaysAllMintCosts: true,
    rentLamports: rent.toString(), protocolLamports: PROTOCOL.toString(), assetBytes: minted.data.length,
    payerDifferentFromAuthorizedMinter: true, extraAuthorizedMinterSignature: true, representsStandardPublicBuyer: false,
    ownerPaidMintOverheadLamports: '0', guardChanged: false };
  const guardAfter = svm.getAccount(roles.guard), collectionAfter = svm.getAccount(roles.collection), machineAfter = svm.getAccount(roles.machine);
  need(same(guardBefore.data, guardAfter.data) && guardBefore.lamports === guardAfter.lamports, 'HIDDEN_VM_GUARD_CHANGED');
  const [machineStart] = machineSerializer.deserialize(machineBefore.data), [machineEnd] = machineSerializer.deserialize(machineAfter.data);
  const mintCount = sampleAssets.length + 1;
  need(machineStart.itemsRedeemed === 0n && machineEnd.itemsRedeemed === BigInt(mintCount)
    && same(machineSerializer.serialize({ ...machineEnd, itemsRedeemed: 0n }), machineSerializer.serialize(machineStart))
    && machineBefore.lamports === machineAfter.lamports && machineAfter.data.length === 652, 'HIDDEN_VM_MACHINE_CHANGED');
  const [collectionStart, startEnd] = collectionSerializer.deserialize(collectionBefore.data), [collectionEnd, endEnd] = collectionSerializer.deserialize(collectionAfter.data);
  need(collectionEnd.numMinted === collectionStart.numMinted + mintCount && collectionEnd.currentSize === collectionStart.currentSize + mintCount
    && startEnd === endEnd && same(collectionSerializer.serialize({ ...collectionEnd, numMinted: collectionStart.numMinted,
      currentSize: collectionStart.currentSize }), collectionBefore.data.slice(0, startEnd))
    && same(collectionBefore.data.slice(startEnd), collectionAfter.data.slice(endEnd)) && collectionBefore.lamports === collectionAfter.lamports,
  'HIDDEN_VM_COLLECTION_CHANGED');
  report.finalMintState = { mintCount, machineItemsRedeemed: mintCount, hiddenMachineBytes: 652,
    guardUnchanged: true, collectionPolicyAndPluginsUnchanged: true, machineConfigurationUnchanged: true,
    sequentialIndexedMetadataVerified: true, entireSupplyMinted: false, verified: true };
  report.status = 'isolated-hidden-costs-passed'; report.completedAt = new Date().toISOString();
  return { report, plan };
}
