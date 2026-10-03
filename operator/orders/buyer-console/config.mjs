import {PublicKey} from '@solana/web3.js';
const need=(ok)=>{if(!ok)throw Error('CONSOLE_CONFIGURATION');};
export function validateConsoleConfig(value){
  need(value&&Object.keys(value).sort().join(' ')==='cluster collection guard machine origin version');
  need(value.version===1&&value.cluster==='devnet');
  const url=new URL(value.origin);need(url.protocol==='https:'&&url.origin===value.origin&&!url.username&&!url.password);
  for(const key of ['machine','collection','guard'])need(typeof value[key]==='string'&&new PublicKey(value[key]).toBase58()===value[key]);
  need(new Set([value.machine,value.collection,value.guard]).size===3);
  return Object.freeze(Object.fromEntries(['version','cluster','origin','machine','collection','guard'].map(key=>[key,value[key]])));
}
export function createScopeIndex({config,localStorage=globalThis.localStorage,locks=globalThis.navigator?.locks}={}){
  config=validateConsoleConfig(config);const key='coolbears:private-buyer-index:v1:'+JSON.stringify(config);
  const valid=row=>row&&Object.keys(row).sort().join(' ')==='buyer id'&&/^[A-Za-z0-9_-]{1,64}$/.test(row.id)
    &&typeof row.buyer==='string'&&new PublicKey(row.buyer).toBase58()===row.buyer;
  const list=()=>{const raw=localStorage.getItem(key);if(raw===null)return[];const value=JSON.parse(raw);
    need(value?.version===1&&Object.keys(value).sort().join(' ')==='orders version'&&Array.isArray(value.orders)&&value.orders.length<=64
      &&value.orders.every(valid)&&new Set(value.orders.map(r=>r.id)).size===value.orders.length);return structuredClone(value.orders);};
  return Object.freeze({list,async save(scope){const row={id:scope.id,buyer:scope.buyer};need(valid(row)&&typeof locks?.request==='function');
    return locks.request(key+':mutation',{mode:'exclusive'},()=>{const rows=list(),existing=rows.find(r=>r.id===row.id);
      if(existing){need(existing.buyer===row.buyer);return;}need(rows.length<64);rows.push(row);
      localStorage.setItem(key,JSON.stringify({version:1,orders:rows}));need(JSON.stringify(list())===JSON.stringify(rows));});}});
}
