import {ID, ISSUER} from './common.mjs';
import {rpc} from './ledger.mjs';

// Both independent operators reported this validated ledger after the November reset.
export const RESET_HASH = '3A0F22236D398D433F8D2F217458A143A95B557B00EE03276D3747E9174725C0';
const resetIndex = 9418;
const delegate = 'rERVPWnVB94yk6szLGFpSdxkjwg5oJJ8mb';
const delegation = 'BB7AD2FF1EC03CCF55838F8ADCE85681323765EED15D050312D3E0D923F181BF';
const required = ['NFTokenMint','NFTokenCreateOffer','NFTokenModify'];

export async function inspectTestnet(call = rpc) {
  try {
    const {info} = await call('server_info');
    const ledger = info?.validated_ledger;
    if (info?.network_id !== 1 || !ID.test(ledger?.hash) || !Number.isSafeInteger(ledger?.seq) ||
        !Number.isFinite(ledger.age) || ledger.age < 0 || ledger.age > 30) return 'network-unavailable';
    if (ledger.seq < resetIndex) return 'collection-unavailable';
    const grant = await call('ledger_entry', {index:delegation, ledger_hash:ledger.hash}, ['entryNotFound']);
    if (grant.error === 'entryNotFound') return 'collection-unavailable';
    if (!grant.validated || grant.ledger_hash !== ledger.hash) return 'network-unavailable';
    const node = grant.node;
    const rights = node?.Permissions?.map(p => p.Permission?.PermissionValue);
    if (node?.LedgerEntryType !== 'Delegate' || node.Account !== ISSUER || node.Authorize !== delegate ||
        rights?.length !== required.length || !required.every(right => rights.includes(right)))
      return 'collection-unavailable';
    const anchor = await call('ledger',{ledger_index:resetIndex,transactions:false});
    if (!anchor.validated) return 'network-unavailable';
    return anchor.ledger?.ledger_hash === RESET_HASH && Number(anchor.ledger.ledger_index) === resetIndex
      ? 'ready' : 'collection-unavailable';
  } catch {
    return 'network-unavailable';
  }
}

let cached, expires = 0;
export async function testnetState() {
  if (Date.now() < expires) return cached;
  const started = Date.now();
  const state = await inspectTestnet();
  if (started + 10000 > expires) {cached = state; expires = started + 10000;}
  return state;
}
