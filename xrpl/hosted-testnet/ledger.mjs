import {assert, ID, ISSUER, PRICE} from './common.mjs';
const RPC = 'https://s.altnet.rippletest.net:51234/';
export async function rpc(method, params = {}, allowed = []) {
  const res = await fetch(RPC, {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({method, params:[{api_version:2, ...params}]}), signal:AbortSignal.timeout(12000)});
  assert(res.ok, 'Testnet RPC unavailable');
  const {result} = await res.json();
  assert(result && (result.status === 'success' || allowed.includes(result.error)), 'Testnet RPC: '+(result?.error || 'invalid reply'));
  return result;
}
export async function read(method, ledger, params) {
  const value = await rpc(method, {ledger_hash:ledger.hash,...params});
  assert(value.validated && value.ledger_hash === ledger.hash);
  return value;
}
export async function snapshot() {
  const {info} = await rpc('server_info');
  const l = info.validated_ledger;
  assert(info.network_id === 1 && l.age <= 30 && ID.test(l.hash) && Number.isSafeInteger(l.seq));
  const {ledger} = await read('ledger', l, {transactions:false});
  return {...l, close:ledger.close_time};
}
export function newOffer(meta, draft) {
  const nodes = meta.AffectedNodes.map(n => n.CreatedNode).filter(n => n?.LedgerEntryType === 'NFTokenOffer');
  assert(nodes.length === 1);
  const {LedgerIndex:id, NewFields:f} = nodes[0];
  assert(ID.test(id) && ID.test(f.NFTokenID) && (!draft.NFTokenID || draft.NFTokenID === f.NFTokenID) &&
    f.Owner === ISSUER && f.Flags === 1 && f.Destination === draft.Destination && f.Amount === PRICE && f.Expiration === draft.Expiration);
  return {id,token:f.NFTokenID};
}
export function matchOffer(f, row) {
  assert(f && f.NFTokenID === row.token && f.Owner === ISSUER && f.Flags === 1 &&
    f.Amount === PRICE && f.Destination === row.buyer && f.Expiration === row.expires);
}
export async function entry(row, ledger) {
  const q = typeof ledger === 'number' ? {ledger_index:ledger} : {ledger_hash:ledger.hash};
  const r = await rpc('ledger_entry', {...q,index:row.offer}, ['entryNotFound']);
  if (r.error === 'entryNotFound') return false;
  assert(r.validated && (typeof ledger === 'number' ? r.ledger_index === ledger : r.ledger_hash === ledger.hash));
  assert(r.node?.LedgerEntryType === 'NFTokenOffer');
  matchOffer(r.node, row);
  return true;
}
// Locate the precise ledger that removed the offer, even if the shop was offline for a long time.
export async function removal(row, ledger) {
  let lo = row.ledger, hi = ledger.seq;
  assert(lo < hi);
  while (hi - lo > 1) {
    const mid = Math.floor((lo+hi)/2);
    if (await entry(row, mid)) lo = mid;
    else hi = mid;
  }
  const page = await rpc('account_tx',{account:ISSUER,ledger_index_min:hi,ledger_index_max:hi,limit:200});
  assert(page.validated && page.ledger_index_min === hi && page.ledger_index_max === hi && !page.marker);
  for (const t of page.transactions) {
    const removed = t.meta.AffectedNodes.find(n => n.DeletedNode?.LedgerIndex === row.offer)?.DeletedNode;
    if (!removed) continue;
    assert(removed.LedgerEntryType === 'NFTokenOffer' && ID.test(t.hash));
    matchOffer(removed.FinalFields, row);
    const tx = t.tx_json, code = t.meta.TransactionResult;
    if (tx.TransactionType === 'NFTokenAcceptOffer' && tx.NFTokenSellOffer === row.offer) {
      if (code === 'tecEXPIRED') return null;
      assert(code === 'tesSUCCESS' && tx.Account === row.buyer && !tx.NFTokenBuyOffer && !tx.NFTokenBrokerFee);
      return t.hash;
    }
    assert(tx.TransactionType === 'NFTokenCancelOffer' && code === 'tesSUCCESS');
    return null;
  }
  throw Error('Offer removal not yet available');
}
