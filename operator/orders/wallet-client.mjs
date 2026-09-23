// Sign-only Wallet Standard coordinator. No RPC endpoint, secret or sender here.
// checkPrepared is a trusted application dependency; never a report supplied by UI.
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { validateAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from './signing.mjs';
const feature = 'solana:signTransaction', chain = 'solana:devnet';
const need = (ok, code) => { if (!ok) throw Error(code); };
const hash = value => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
async function bounded(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
export function compatibleBuyerWallet(wallet) {
  return wallet?.chains?.includes(chain) && typeof wallet.features?.['standard:connect']?.connect === 'function'
    && typeof wallet.features?.['standard:events']?.on === 'function'
    && typeof wallet.features?.[feature]?.signTransaction === 'function'
    && wallet.features[feature].supportedTransactionVersions?.includes(0);
}
function accountFor(wallet, buyer) {
  return wallet?.accounts?.find(account => {
    try { return account.address === buyer && new PublicKey(account.publicKey).toBase58() === buyer
      && account.chains.includes(chain) && account.features.includes(feature); } catch { return false; }
  });
}
export function validateWalletCheck(report, order, request, now = Date.now()) {
  need(report?.status === 'wallet-check-passed' && report.mode === 'closed-devnet-sign-only-check'
    && report.cluster === 'devnet' && report.orderId === order.id && report.orderRevision === order.revision
    && report.orderSha256 === hash(order) && report.requestId === buyerRequestId(request)
    && report.candidate?.transactionBase64 === request.transactionBase64
    && report.candidate.messageSha256 === request.messageSha256
    && report.candidate.blockhash === request.blockhash && report.candidate.lastValidBlockHeight === request.lastValidBlockHeight
    && report.candidate.asset === request.asset && report.itemIndex === 0 && report.quantity === order.quantity
    && report.networkVerified === true && report.guardPriceVerified === true && report.blockhashVerified === true
    && report.simulationVerified === true && report.simulationMode === 'unsigned'
    && Number.isSafeInteger(report.checkedSlot) && report.checkedSlot >= 0
    && report.readyToSign === true && report.readyToSubmit === false && report.salesOpen === false
    && Number.isSafeInteger(report.checkedAt) && Number.isSafeInteger(report.expiresAt)
    && report.checkedAt <= now && report.expiresAt > now && report.expiresAt - report.checkedAt <= 20000,
  'PREFLIGHT_BLOCKED');
}
export function createBuyerWalletClient({ storage, scope, checkPrepared,
  storageManager = globalThis.navigator?.storage, onChange = () => {}, walletTimeoutMs = 120000 } = {}) {
  need(storage && typeof checkPrepared === 'function' && Number.isSafeInteger(walletTimeoutMs)
    && walletTimeoutMs >= 20 && walletTimeoutMs <= 180000, 'CLIENT_CONFIGURATION');
  scope = structuredClone(scope); need(scope.cluster === 'devnet', 'DEVNET_ONLY');
  let wallet, account, off, order, partial, saved, memory, busy = false, epoch = 0, disposed = false;
  const notify = () => { try { onChange(); } catch {} };
  const changed = () => { epoch++; account = null; notify(); };
  async function persistent() {
    need(typeof storageManager?.persisted === 'function', 'PERSISTENT_STORAGE_REQUIRED');
    need(await bounded(storageManager.persisted(), 5000, 'STORAGE_UNAVAILABLE') === true, 'PERSISTENT_STORAGE_REQUIRED');
  }
  async function load() {
    order = await storage.read(scope); need(order, 'MISSING_ORDER');
    partial = await storage.readAssetSigning(scope);
    saved = await storage.readBuyerResponse(scope);
    return state();
  }
  function state() {
    return {orderId:scope.id, connected:!!account, busy, disposed,
      status:saved?.status ?? partial?.status ?? 'not-prepared', canRecover:!!memory,
      canRequestSignature:!disposed && !!account && !busy && !saved && order?.revision === 1
        && !order.paused && partial?.status === 'asset-partial-saved',
      readyToSign:false, readyToSubmit:false, salesOpen:false};
  }
  async function saveMemory() {
    need(memory, 'NO_RESPONSE_TO_RECOVER');
    const pending = memory;
    const result = await storage.saveBuyerResponse(scope, pending);
    need(result?.status === 'buyer-response-saved' && result.response?.transactionBase64 === pending.transactionBase64
      && result.claim.claimId === pending.claimId, 'SAVE_UNCONFIRMED');
    saved = result; if (memory === pending) memory = null; notify(); return result;
  }
  return Object.freeze({
    load, state,
    // A future UI must explain profile/device loss before invoking this explicitly.
    async requestPersistence() {
      need(!disposed && !busy && typeof storageManager?.persist === 'function', 'STORAGE_UNAVAILABLE');
      need(await bounded(storageManager.persist(), 5000, 'STORAGE_UNAVAILABLE') === true, 'PERSISTENT_STORAGE_REQUIRED');
      await persistent(); return true;
    },
    async connect(selected) {
      need(!disposed && !busy && compatibleBuyerWallet(selected), 'WALLET_UNSUPPORTED'); busy = true;
      off?.(); wallet = null; account = null; const generation = ++epoch;
      try {
        await bounded(selected.features['standard:connect'].connect(), 15000, 'WALLET_CONNECT_TIMEOUT');
        need(!disposed && epoch === generation, 'WALLET_CHANGED');
        account = accountFor(selected, scope.buyer); need(account, 'WRONG_WALLET');
        wallet = selected; off = selected.features['standard:events'].on('change', changed);
      } finally { busy = false; notify(); }
      return state();
    },
    async signOnly() {
      need(state().canRequestSignature, 'NOT_READY'); busy = true;
      const selected = wallet, selectedAccount = account, generation = epoch;
      const stableWallet = () => need(!disposed && selected === wallet && epoch === generation
        && account === selectedAccount && accountFor(selected, scope.buyer) === selectedAccount
        && compatibleBuyerWallet(selected), 'WALLET_CHANGED');
      try {
        await persistent(); await load();
        need(!saved && order.revision === 1 && !order.paused && partial?.status === 'asset-partial-saved', 'NOT_READY');
        const before = structuredClone(order), bundle = structuredClone(partial);
        validateAssetRequest(before, bundle.claim, bundle.request); stableWallet();
        const started = performance.now();
        const report = await bounded(checkPrepared({order:structuredClone(before),claim:bundle.claim,request:bundle.request}), 35000, 'PREFLIGHT_TIMEOUT');
        validateWalletCheck(report, before, bundle.request);
        need(performance.now() - started <= 30000, 'PREFLIGHT_BLOCKED');
        const checked = performance.now(), remaining = report.expiresAt - Date.now();
        stableWallet();
        const claimed = await storage.claimBuyerWallet(scope, {orderRevision:before.revision,requestId:buyerRequestId(bundle.request)});
        saved = claimed; need(claimed.status === 'wallet-response-unknown', 'SAVE_UNCONFIRMED');
        await persistent(); stableWallet();
        need(Date.now() < report.expiresAt && performance.now() - checked < remaining, 'PREFLIGHT_BLOCKED');
        // Claim is committed/read back. No await between final wallet checks and call.
        const work = Promise.resolve().then(() => {
          stableWallet();
          need(Date.now() < report.expiresAt && performance.now() - checked < remaining, 'PREFLIGHT_BLOCKED');
          try { return Promise.resolve(selected.features[feature].signTransaction({account:selectedAccount,chain,
            transaction:Uint8Array.from(Buffer.from(bundle.request.transactionBase64,'base64'))}))
            .catch(error => { throw Error(error?.code === 4001 ? 'WALLET_CANCELLED' : 'WALLET_RESPONSE_UNKNOWN'); }); }
          catch (error) { throw Error(error?.code === 4001 ? 'WALLET_CANCELLED' : 'WALLET_RESPONSE_UNKNOWN'); }
        }).then(async outputs => {
          need(Array.isArray(outputs) && outputs.length === 1 && outputs[0]?.signedTransaction instanceof Uint8Array
            && outputs[0].signedTransaction.length <= 1232, 'WALLET_RESPONSE');
          const transactionBase64 = Buffer.from(outputs[0].signedTransaction).toString('base64');
          // Account changes/timeout do not discard a valid old response. Save evidence.
          // Verify against the immutable pre-call snapshot before any storage await.
          // saveBuyerResponse independently checks the current journal and claim.
          verifyBuyerSigningResponse(before, bundle.claim, bundle.request, {transactionBase64});
          memory = {claimId:claimed.claim.claimId,transactionBase64};
          return saveMemory();
        });
        // work continues to validate/store a late response, never invokes the wallet again.
        return await bounded(work, walletTimeoutMs, 'WALLET_RESPONSE_PENDING');
      } finally { busy = false; notify(); }
    },
    async recover() {
      need(!busy, 'BUSY'); busy = true;
      try { if (memory) return await saveMemory(); await load(); return saved; }
      finally { busy = false; notify(); }
    },
    dispose() { disposed = true; epoch++; off?.(); wallet = null; account = null; notify(); },
  });
}
