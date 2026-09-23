import { PublicKey } from '@solana/web3.js';
import { validateSigningRequest, verifySigningResponse } from '../signing.mjs';
import { validateSigningGroup, signingGroupId, verifySigningGroupResponse } from '../group-signing.mjs';
const feature = 'solana:signTransaction', chain = 'solana:devnet';
const fail = code => { throw Object.assign(Error(code), { code }); };
const need = (ok, code) => { if (!ok) fail(code); };
export function compatibleOwnerWallet(wallet) {
  return wallet?.chains?.includes(chain) && typeof wallet.features?.['standard:connect']?.connect === 'function'
    && typeof wallet.features?.['standard:events']?.on === 'function'
    && typeof wallet.features?.[feature]?.signTransaction === 'function'
    && wallet.features[feature].supportedTransactionVersions?.includes(0);
}
function accountFor(wallet, owner) {
  return wallet.accounts?.find(account => {
    try { return account.address === owner && new PublicKey(account.publicKey).toBase58() === owner
      && account.chains.includes(chain) && account.features.includes(feature); } catch { return false; }
  });
}
export function createOwnerClient({ api, storage, onChange = () => {} }) {
  let view, record, wallet, account, off, busy = false, generation = 0;
  const notifyWalletChange = () => { generation++; account = null; onChange(); };
  function checkRequest(request) {
    validateSigningRequest(request);
    need(request.cluster === 'devnet' && request.owner === view.owner && request.messageSha256 === view.messageSha256
      && request.deploymentId === view.deploymentId && request.stepId === view.stepId && request.attempt === view.attempt, 'REQUEST_CHANGED');
  }
  function checkGroup(requests) {
    const normalized = validateSigningGroup(requests), first = normalized[0];
    need(view.groupId === view.requestId && signingGroupId(normalized) === view.requestId
      && normalized.length === view.groupSize && first.owner === view.owner && first.deploymentId === view.deploymentId
      && first.stepId === view.stepId, 'REQUEST_CHANGED');
    return normalized;
  }
  function checkRecord(value, signed = false) {
    if (view.groupId) {
      need(value.groupId === view.groupId, 'REQUEST_CHANGED'); checkGroup(value.requests);
      if (signed) verifySigningGroupResponse(value.requests, value.transactionBase64s);
    } else {
      need(!value.groupId, 'REQUEST_CHANGED'); checkRequest(value.request);
      if (signed) verifySigningResponse(value.request, { transactionBase64: value.transactionBase64 });
    }
  }
  async function persist(value) { record = value; await storage.put(view.requestId, value); }
  async function save() {
    need(record?.status === 'signed' && record.requestId === view.requestId, 'NO_SAVED_SIGNATURE');
    checkRecord(record, true);
    const result = await api(view.groupId ? '/api/group-signature' : '/api/signature', { requestId: view.requestId,
      ...(view.groupId ? { transactionBase64s: record.transactionBase64s } : { transactionBase64: record.transactionBase64 }) });
    need(result.status === 'saved' && result.requestId === view.requestId && result.signed === true, 'SAVE_UNCONFIRMED');
    view = result;
    // If browser storage fails after the server committed, retain the response
    // in memory; server state remains authoritative and reload does not re-sign.
    try { await persist({ ...record, accepted: true }); } catch {}
    return result;
  }
  return {
    async load() {
      const next = await api('/api/state');
      need(next.cluster === 'devnet' && typeof next.owner === 'string' && /^[a-f0-9]{64}$/.test(next.requestId), 'STATE');
      view = next;
      if (!record || record.requestId !== view.requestId) record = await storage.get(view.requestId);
      if (record) {
        need(record.requestId === view.requestId && ['wallet-pending', 'cancelled', 'unknown', 'signed'].includes(record.status), 'STORAGE');
        checkRecord(record, record.status === 'signed');
      }
      return this.state();
    },
    state() { return { ...view, connected: !!account, walletName: wallet?.name ?? '', busy,
      localStatus: record?.status ?? null, canRecover: record?.status === 'signed' && !view?.signed,
      canSign: !!account && !busy && view?.state === 'wallet-pending' && !view.signed && !view.walletRequested
        && (!record || record.status === 'cancelled'), canExport: record?.status === 'signed' }; },
    async connect(selected) {
      need(view && !busy && compatibleOwnerWallet(selected), 'WALLET_UNSUPPORTED'); busy = true;
      off?.(); wallet = null; account = null;
      try {
        await selected.features['standard:connect'].connect();
        const eligible = accountFor(selected, view.owner); need(eligible, 'WRONG_WALLET');
        wallet = selected; account = eligible;
        off = selected.features['standard:events'].on('change', notifyWalletChange);
      } finally { busy = false; }
      return this.state();
    },
    async sign() {
      need(this.state().canSign, 'NOT_READY'); busy = true;
      const selected = wallet, epoch = generation;
      try {
        await storage.ready();
        const checked = await api('/api/check', { requestId: view.requestId });
        need(checked.requestId === view.requestId && checked.simulationVerified === true
          && /^[a-f0-9]{64}$/.test(checked.claimId) && Number.isSafeInteger(checked.expiresAt) && checked.expiresAt > Date.now(), 'PREFLIGHT_BLOCKED');
        view = { ...view, walletRequested: true };
        const request = view.groupId ? undefined : structuredClone(checked.request);
        const requests = view.groupId ? checkGroup(structuredClone(checked.requests)) : [request];
        if (!view.groupId) checkRequest(request);
        need(wallet === selected && generation === epoch && account === accountFor(selected, view.owner), 'WALLET_CHANGED');
        // Durable browser intent before opening the wallet: a lost callback is
        // an unknown outcome, not permission to open the same request again.
        const intent = view.groupId ? { groupId: view.groupId, requests } : { request };
        await persist({ requestId: view.requestId, ...intent, claimId: checked.claimId, status: 'wallet-pending' });
        need(checked.expiresAt > Date.now(), 'PREFLIGHT_BLOCKED');
        let outputs;
        try { outputs = await selected.features[feature].signTransaction(...requests.map(item => ({ account, chain,
          transaction: Uint8Array.from(Buffer.from(item.transactionBase64, 'base64')) }))); }
        catch (error) {
          let declined = false;
          if (error?.code === 4001) try {
            const result = await api('/api/decline', { requestId: view.requestId, claimId: checked.claimId });
            need(result.status === 'declined' && result.requestId === view.requestId && !result.walletRequested, 'SAVE_UNCONFIRMED');
            view = result; declined = true;
          } catch {}
          try { await persist({ ...record, status: declined ? 'cancelled' : 'unknown' }); } catch {}
          fail(declined ? 'WALLET_CANCELLED' : 'WALLET_UNKNOWN');
        }
        need(Array.isArray(outputs) && outputs.length === requests.length
          && outputs.every(item => item?.signedTransaction instanceof Uint8Array), 'WALLET_RESPONSE');
        const bytes = outputs.map(item => Buffer.from(item.signedTransaction).toString('base64'));
        if (view.groupId) verifySigningGroupResponse(requests, bytes); else verifySigningResponse(request, { transactionBase64: bytes[0] });
        record = { requestId: view.requestId, ...intent, status: 'signed',
          ...(view.groupId ? { transactionBase64s: bytes } : { transactionBase64: bytes[0] }), accepted: false };
        try { await storage.put(view.requestId, record); } catch { /* Try the durable server and retain recovery export. */ }
        return await save();
      } finally { busy = false; }
    },
    async recover() { need(!busy, 'BUSY'); busy = true; try { return await save(); } finally { busy = false; } },
    exportResponse() { need(record?.status === 'signed', 'NO_SAVED_SIGNATURE'); return structuredClone(record); },
    dispose() { off?.(); wallet = null; account = null; generation++; },
  };
}
