import {ID, ISSUER} from './common.mjs';
import {rpc} from './ledger.mjs';

// The Testnet journal includes a validated resale at this ledger. The network ID
// and RPC URL survive a reset, while this journal and its orders belong to the old history.
const archivedGrant = '6B9024FCD521756DB7D0B351F9AD5DB3BB89BB89432DDDE00738D46BF862F24F';
const journalFloor = 22614399;
const delegate = 'rERVPWnVB94yk6szLGFpSdxkjwg5oJJ8mb';
const delegation = 'BB7AD2FF1EC03CCF55838F8ADCE85681323765EED15D050312D3E0D923F181BF';

export async function inspectTestnet(call = rpc, postResetGrant) {
  try {
    const {info} = await call('server_info');
    const ledger = info?.validated_ledger;
    if (info?.network_id !== 1 || !ID.test(ledger?.hash) || !Number.isSafeInteger(ledger?.seq) ||
        !Number.isFinite(ledger.age) || ledger.age < 0 || ledger.age > 30) return 'network-unavailable';
    if (postResetGrant === undefined) {
      if (ledger.seq < journalFloor) return 'collection-unavailable';
    } else if (!ID.test(postResetGrant) || postResetGrant === archivedGrant) {
      return 'collection-unavailable';
    }

    const grant = await call('ledger_entry', {index:delegation, ledger_hash:ledger.hash}, ['entryNotFound']);
    if (grant.error === 'entryNotFound') return 'collection-unavailable';
    if (!grant.validated || grant.ledger_hash !== ledger.hash) return 'network-unavailable';
    const node = grant.node;
    if (node?.PreviousTxnID !== (postResetGrant ?? archivedGrant)) return 'collection-unavailable';
    const rights = node?.Permissions?.map(p => p.Permission?.PermissionValue);
    if (node?.LedgerEntryType !== 'Delegate' || node.Account !== ISSUER || node.Authorize !== delegate ||
        rights?.length !== 2 || !rights.includes('NFTokenMint') || !rights.includes('NFTokenCreateOffer'))
      return 'collection-unavailable';
    return 'ready';
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
