import {PublicKey} from '/public-mainnet/modules/60139917f8765411c2c3.mjs';
import {networkProfile} from '/public-mainnet/modules/16494c413cb2c41805ca.mjs';
const need=(ok)=>{if(!ok)throw Error('CONSOLE_CONFIGURATION');};
export function validateConsoleConfig(value){
  const hidden=value?.version===2;
  let network;try{network=networkProfile(value?.cluster);}catch{need(false);}
  const keys=['version','cluster','origin','machine','collection','guard',...(hidden?['storageMode','hiddenCommitmentSha256']:[]),...(network.cluster==='mainnet-beta'?['genesisHash']:[])];
  need(value&&Object.keys(value).sort().join(' ')===keys.slice().sort().join(' '));
  need(value.version===(hidden?2:1));
  if(network.cluster==='mainnet-beta')need(value.genesisHash===network.genesisHash);
  if(hidden)need(value.storageMode==='hidden-settings'&&typeof value.hiddenCommitmentSha256==='string'&&/^[a-f0-9]{64}$/.test(value.hiddenCommitmentSha256)&&value.hiddenCommitmentSha256!=='0'.repeat(64));
  const url=new URL(value.origin);need(url.protocol==='https:'&&url.origin===value.origin&&!url.username&&!url.password);
  for(const key of ['machine','collection','guard'])need(typeof value[key]==='string'&&new PublicKey(value[key]).toBase58()===value[key]);
  need(new Set([value.machine,value.collection,value.guard]).size===3);
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,value[key]])));
}
export const consoleStorageOptions=config=>config.version===2?{storageMode:config.storageMode,hiddenCommitmentSha256:config.hiddenCommitmentSha256}:{};
// Accept only a validated native journal: both unpaid attempts expired on chain,
// no NFT was issued, and no other item was attempted. The journal stays intact.
export function spentUnsignedOrder(record){
  const items=record?.order?.items;
  const beforeWallet=record?.prewalletRecovery,afterWallet=record?.responseRecovery;
  const final=beforeWallet??afterWallet;
  if(beforeWallet&&afterWallet)return false;
  if(record?.readOnly!==true||record.custody?.status!=='available'||!Array.isArray(items)||!items.length||
     final?.status!=='expired'||final.report?.status!==(beforeWallet?'prewallet-expired':'response-expired')||final.report.chainVerified!==true)return false;
  const [first,...rest]=items;
  return first.attempts?.length===2&&rest.every(i=>i.attempts?.length===0)&&first.attempts.every((a,i)=>
    a.number===i+1&&a.state==='expired'&&a.signature===null&&a.proof?.kind==='expired'&&a.proof.signature===null&&
    a.proof.commitment==='finalized'&&a.proof.blockhashValid===false&&a.proof.blockHeight>a.lastValidBlockHeight&&
    a.proof.signatureAbsent===true&&a.proof.accountAbsent===true&&a.proof.addressHistoryEmpty===true);
}
// A sign-only request without a returned signature cannot be broadcast by this app.
export function unpaidDraft(record){
  return record?.readOnly===true && record.custody?.status==='available' &&
    !!record.order?.items?.length && !record.submission &&
    record.order.items.every(item=>item.attempts.every(attempt=>
      attempt.signature===null && ['wallet-pending','unknown','cancelled','expired'].includes(attempt.state)));
}
export function createScopeIndex({config,localStorage=globalThis.localStorage,locks=globalThis.navigator?.locks}={}){
  config=validateConsoleConfig(config);const key='coolbears:private-buyer-index:v1:'+JSON.stringify(config);
  const valid=row=>row&&Object.keys(row).sort().join(' ')==='buyer id'&&/^[A-Za-z0-9_-]{1,64}$/.test(row.id)
    &&typeof row.buyer==='string'&&new PublicKey(row.buyer).toBase58()===row.buyer;
  const list=()=>{const raw=localStorage.getItem(key);if(raw===null)return[];const value=JSON.parse(raw);
    need(value?.version===1&&Object.keys(value).sort().join(' ')==='orders version'&&Array.isArray(value.orders)
      &&value.orders.every(valid)&&new Set(value.orders.map(r=>r.id)).size===value.orders.length);return structuredClone(value.orders);};
  return Object.freeze({list,async save(scope){const row={id:scope.id,buyer:scope.buyer};need(valid(row)&&typeof locks?.request==='function');
    return locks.request(key+':mutation',{mode:'exclusive'},()=>{const rows=list(),existing=rows.find(r=>r.id===row.id);
      if(existing){need(existing.buyer===row.buyer);return;}rows.push(row);
      localStorage.setItem(key,JSON.stringify({version:1,orders:rows}));need(JSON.stringify(list())===JSON.stringify(rows));});}});
}
