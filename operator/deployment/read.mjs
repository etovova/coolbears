// Read-only checks for the policy-bound full deployment. Nothing here signs,
// submits, changes a journal, proves absence, or authorizes opening sales.
import { createHash } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { readDeploymentJournal, nextDeploymentAction, sha256Json } from './journal.mjs';
import { validateCanonicalDeploymentManifest } from './intent.mjs';
import { createDeploymentRpc, assertCluster, DeploymentRpcError } from './rpc.mjs';
import { expectedAccountAddresses, verifyExpectedAccounts } from './accounts.mjs';
import { verifyFinalizedReceipt } from './receipt.mjs';

const PROGRAMS = [MPL_CORE_PROGRAM_ID, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID];
const ACTIVE = new Set(['wallet-pending', 'signed', 'send-claimed', 'accepted', 'unknown']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
function requireThat(value, code) { if (!value) throw Object.assign(Error(code), { checkCode: code }); }
function context(result, minimum = 0) {
  requireThat(integer(result?.context?.slot) && result.context.slot >= minimum && Object.hasOwn(result, 'value'), 'INVALID_RPC_CONTEXT');
  return result.context.slot;
}
function amount(value) {
  requireThat(integer(value), 'INVALID_RPC_AMOUNT');
  return BigInt(value);
}
function hashMessage(tx) { return createHash('sha256').update(tx.message.serialize()).digest('hex'); }
function binding(snapshot, stepId) {
  return { deploymentId: snapshot.manifest.id, manifestSha256: snapshot.manifestSha256,
    expectedRevision: snapshot.revision, expectedHeadHash: snapshot.headHash, stepId };
}
async function unchanged(directory, baseline) {
  const fresh = await readDeploymentJournal(directory);
  requireThat(fresh.manifestSha256 === baseline.manifestSha256 && fresh.revision === baseline.revision && fresh.headHash === baseline.headHash, 'JOURNAL_CHANGED_DURING_READ');
}
async function target(directory, stepId) {
  const snapshot = await readDeploymentJournal(directory);
  const plan = await validateCanonicalDeploymentManifest(snapshot.manifest);
  const index = plan.steps.findIndex(step => step.id === stepId);
  requireThat(index >= 0, 'UNKNOWN_DEPLOYMENT_STEP');
  const action = nextDeploymentAction(snapshot);
  requireThat(action.stepId === stepId, 'STEP_NOT_CURRENT');
  return { snapshot, plan, index, step: plan.steps[index], attempt: snapshot.steps[index].attempts.at(-1), action };
}

// All deployment-owned accounts come from one finalized bank. Recheck the
// entire completed config-line prefix, rather than trusting cache.loaded or
// the most recently inserted handful of lines.
async function checkState(rpc, plan, completedIndex, minimum = 0) {
  const { collection, reservedAsset, machine, guard } = plan.roles;
  const addresses = [...PROGRAMS, collection, reservedAsset, machine, guard];
  const result = await rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized', minContextSlot: minimum }]);
  const slot = context(result, minimum);
  requireThat(Array.isArray(result.value) && result.value.length === addresses.length, 'INVALID_ACCOUNT_LIST');
  for (let i = 0; i < PROGRAMS.length; i++) requireThat(result.value[i]?.executable === true, 'PROGRAM_UNAVAILABLE');
  const accounts = new Map(addresses.map((address, i) => [address, result.value[i]]));
  const inspect = expected => {
    const keys = expectedAccountAddresses(expected);
    verifyExpectedAccounts(expected, keys, keys.map(key => accounts.get(key)));
  };
  for (const [i, keys] of [[0, [collection]], [1, [reservedAsset]], [2, [machine, guard]]]) {
    if (completedIndex < i) for (const key of keys) requireThat(accounts.get(key) === null, 'NEW_ACCOUNT_ALREADY_EXISTS');
    else if (i === 0) inspect({ ...plan.steps[0].expected,
      ...(completedIndex >= 1 ? { reservedAssetCreated: true } : {}),
      ...(completedIndex >= 2 ? { machine } : {}) });
    else if (i === 1) inspect(plan.steps[1].expected);
  }
  if (completedIndex >= 2) {
    const lines = plan.steps.slice(3, completedIndex + 1).flatMap(step => step.expected.configLines);
    inspect({ ...plan.steps[2].expected, itemsLoaded: lines.length });
    if (lines.length) inspect({ machine, authority: plan.roles.owner, startingIndex: 0, count: lines.length, configLines: lines });
  }
  return slot;
}

function blocked(error, phase, rpc, status) {
  // Never echo an RPC URL, account bytes, arbitrary provider error or assertion.
  const moduleCodes = new Set(['DEPLOYMENT_INTENT_INVALID', 'DEPLOYMENT_RECEIPT_INVALID', 'EXPECTED_ACCOUNT_STATE_MISMATCH']);
  const code = error instanceof DeploymentRpcError ? `RPC_${error.code}`
    : error?.checkCode ?? (moduleCodes.has(error?.code) ? error.code : 'DEPLOYMENT_READ_CHECK_FAILED');
  return { status, phase, code,
    networkRequests: rpc?.requests ?? 0, transactionsSent: 0, journalWrites: 0,
    readyToSubmit: false, salesOpen: false };
}

// Shared read-only primitives; callers still rebuild canonical intent and
// recheck the journal after asynchronous network work.
export { context as rpcContext, amount as rpcAmount, binding as snapshotBinding,
  unchanged as assertJournalUnchanged, checkState as checkDeploymentState,
  requireThat as requireDeploymentCheck, blocked as blockedDeploymentReport };

export async function preflightDeploymentStep({ directory, stepId, endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, phase = 'journal';
  try {
    const { snapshot, plan, index, step, attempt, action } = await target(directory, stepId);
    requireThat(action.type !== 'reconcile' || ['wallet-pending', 'signed'].includes(attempt?.state), 'RECONCILIATION_REQUIRED');
    phase = 'network';
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000 });
    const startedAt = performance.now();
    const genesisHash = await assertCluster(rpc, plan.cluster);
    phase = 'accounts';
    const accountSlot = await checkState(rpc, plan, index - 1);
    phase = 'budget';
    const balanceResult = await rpc.call('getBalance', [plan.roles.owner, { commitment: 'finalized', minContextSlot: accountSlot }]);
    const balanceSlot = context(balanceResult, accountSlot);
    const balance = amount(balanceResult.value);
    const machineRent = amount(await rpc.call('getMinimumBalanceForRentExemption', [plan.machineSpace, { commitment: 'finalized' }]));
    requireThat(machineRent > 0n, 'INVALID_MACHINE_RENT');
    if (index <= 2) requireThat(machineRent.toString() === plan.machineRentLamports, 'MACHINE_RENT_CHANGED_REBUILD_PLAN');

    phase = 'blockhash';
    const saved = ['wallet-pending', 'signed'].includes(attempt?.state);
    const transaction = VersionedTransaction.deserialize(Buffer.from(saved
      ? (attempt.signed?.transactionBase64 ?? attempt.request.transactionBase64) : step.transactionBase64, 'base64'));
    let lastValidBlockHeight = saved ? attempt.request.lastValidBlockHeight : null;
    let quoteSlot = balanceSlot;
    if (!saved) {
      const latest = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed', minContextSlot: quoteSlot }]);
      quoteSlot = context(latest, quoteSlot);
      requireThat(typeof latest.value?.blockhash === 'string' && integer(latest.value.lastValidBlockHeight) && latest.value.lastValidBlockHeight > 0, 'INVALID_LATEST_BLOCKHASH');
      transaction.message.recentBlockhash = latest.value.blockhash;
      // Serializing below also validates the blockhash as a 32-byte public key.
      lastValidBlockHeight = latest.value.lastValidBlockHeight;
    }
    const messageBase64 = Buffer.from(transaction.message.serialize()).toString('base64');
    phase = 'fee';
    const feeResult = await rpc.call('getFeeForMessage', [messageBase64, { commitment: 'confirmed', minContextSlot: quoteSlot }]);
    quoteSlot = context(feeResult, quoteSlot);
    requireThat(feeResult.value !== null, 'FEE_QUOTE_UNAVAILABLE');
    const fee = amount(feeResult.value);
    requireThat(fee > 0n, 'INVALID_FEE_QUOTE');
    const knownCosts = fee + (index === 2 ? machineRent : 0n);
    requireThat(balance >= knownCosts, 'BALANCE_BELOW_KNOWN_COSTS');
    phase = 'blockhash';
    const valid = await rpc.call('isBlockhashValid', [transaction.message.recentBlockhash, { commitment: 'confirmed', minContextSlot: quoteSlot }]);
    quoteSlot = context(valid, quoteSlot);
    requireThat(valid.value === true, 'BLOCKHASH_NOT_VALID');
    const height = await rpc.call('getBlockHeight', [{ commitment: 'confirmed', minContextSlot: quoteSlot }]);
    requireThat(integer(height) && height < lastValidBlockHeight, 'BLOCK_HEIGHT_NOT_USABLE');
    requireThat(performance.now() - startedAt <= 30000, 'READ_CHECK_TOO_OLD');
    phase = 'journal';
    await unchanged(directory, snapshot);
    requireThat(performance.now() - startedAt <= 30000, 'READ_CHECK_TOO_OLD');
    return { status: 'read-checks-passed', ...binding(snapshot, stepId), source: saved ? 'saved-attempt' : 'refreshed-unsigned-template',
      cluster: plan.cluster, genesisHash, accountSlot, quoteSlot, checkedAt: new Date().toISOString(),
      candidate: { transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        messageSha256: hashMessage(transaction), blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight, requiredSigners: step.requiredSigners },
      budget: { scope: 'partial-step-estimate', complete: false, ownerBalanceLamports: balance.toString(),
        stepNetworkFeeLamports: fee.toString(), machineRentLamports: machineRent.toString(), machineSpace: plan.machineSpace,
        knownStepCostsLamports: knownCosts.toString(), totalDeploymentLamports: null,
        excluded: ['collection-rent', 'reserved-asset-rent', 'guard-rent', 'protocol-charges', 'other-step-fees', 'retries'] },
      blockhashValidAtRead: true, lifetimeGuaranteed: false, simulationVerified: false,
      networkRequests: rpc.requests, transactionsSent: 0, journalWrites: 0, readyToSubmit: false, salesOpen: false };
  } catch (error) { return blocked(error, phase, rpc, 'blocked'); }
}

export async function reconcileDeploymentStep({ directory, stepId, endpoint, fetchImpl, timeoutMs } = {}) {
  let rpc, phase = 'journal';
  try {
    const { snapshot, plan, index, step, attempt } = await target(directory, stepId);
    requireThat(ACTIVE.has(attempt?.state) && attempt?.signed, 'SIGNED_ATTEMPT_REQUIRED');
    phase = 'network';
    rpc = createDeploymentRpc({ endpoint, fetchImpl, timeoutMs, totalTimeoutMs: 30000 });
    const startedAt = performance.now();
    const genesisHash = await assertCluster(rpc, plan.cluster);
    phase = 'receipt';
    const statusResult = await rpc.call('getSignatureStatuses', [[attempt.signed.signature], { searchTransactionHistory: true }]);
    const transactionResult = await rpc.call('getTransaction', [attempt.signed.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
    const receipt = verifyFinalizedReceipt({ request: attempt.request, signed: attempt.signed, statusResult, transactionResult });
    phase = 'accounts';
    const readSlot = await checkState(rpc, plan, index, receipt.slot);
    phase = 'journal';
    await unchanged(directory, snapshot);
    requireThat(performance.now() - startedAt <= 30000, 'READ_CHECK_TOO_OLD');
    const proof = { kind: 'verified', manifestSha256: snapshot.manifestSha256, stepId, attempt: attempt.number,
      messageSha256: receipt.messageSha256, signature: receipt.signature, commitment: 'finalized',
      slot: receipt.slot, readSlot, expectedSha256: sha256Json(step.expected),
      transactionSucceeded: true, expectedStateVerified: true };
    return { status: 'verified', ...binding(snapshot, stepId), cluster: plan.cluster, genesisHash,
      proof, networkRequests: rpc.requests, transactionsSent: 0, journalWrites: 0, readyToSubmit: false, salesOpen: false };
  } catch (error) { return blocked(error, phase, rpc, 'unknown'); }
}
