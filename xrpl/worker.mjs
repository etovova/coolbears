export const REVEAL_AT = Date.parse('2027-02-01T00:00:00Z');
export const PRICE = '10000000';
export const TAXON = 20270201;
export const OWNER = 'ra7rAR24tKDsbmaJmikRjgCpoPZtFHsaJr';
const ID = /^[A-F0-9]{64}$/;
const internalOrigin = 'https://private.invalid/internal/';
const encoder = new TextEncoder();
const publicFiles = new Map([
  ['/xrpl/', ['home.html', 'text/html; charset=utf-8']],
  ['/xrpl/site.css', ['site.css', 'text/css']],
  ['/xrpl/app.js', ['app.js', 'text/javascript']],
  ['/xrpl/wallet.js', ['wallet.js', 'text/javascript']],
  ['/xrpl/cover.gif', ['cover.gif', 'image/gif']],
  ['/xrpl/logo.png', ['logo.png', 'image/png']],
  ['/privacy.html', ['privacy.html', 'text/html; charset=utf-8']],
  ['/terms.html', ['terms.html', 'text/html; charset=utf-8']]
]);
for(let n=2;n<=7;n++){
 const id=String(n).padStart(2,'0');
 publicFiles.set('/xrpl/gallery/'+id+'.webp',['gallery'+id+'.webp','image/webp']);
}
const security = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"};

function response(data, type, status = 200) {
  return new Response(data, {status, headers:{...security,'Content-Type':type,'Cache-Control':'no-store'}});
}
const json = (data, status) => response(JSON.stringify(data),'application/json',status);

function siteEnvironment(host, env) {
  if (host === 'coolbears-nfts.com' || host === 'www.coolbears-nfts.com')
    return {...env, NETWORK:'mainnet', SALES_OPEN:'no', METADATA_ORIGIN:'https://coolbears-nfts.com'};
  return env;
}
function network(env) {
  if (env.NETWORK === 'testnet' && env.TEST_ISSUER && env.TEST_ISSUER !== OWNER)
    return {name:'Testnet', issuer:env.TEST_ISSUER, id:1, rpc:'https://s.altnet.rippletest.net:51234/'};
  if (env.NETWORK === 'mainnet')
    return {name:'Mainnet', issuer:OWNER, id:0, rpc:'https://s1.ripple.com:51234/'};
  throw Error('Network is not configured');
}
async function rpc(net, method, params) {
  const r = await fetch(net.rpc,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({method,params:[{api_version:2,...params}]}),signal:AbortSignal.timeout(16000)});
  if (!r.ok) throw Error('Ledger unavailable');
  const {result} = await r.json();
  if (!result || result.status === 'error') {
    if (method==='tx' && result?.error==='txnNotFound') return null;
    if (method==='ledger_entry' && result?.error==='entryNotFound') return null;
    throw Error('Ledger request failed');
  }
  return result;
}
async function snapshot(net) {
  const {info} = await rpc(net,'server_info',{});
  if (info.network_id !== net.id || !ID.test(info.validated_ledger?.hash) ||
      info.validated_ledger.age > 30) throw Error('Unconfirmed ledger');
  return info.validated_ledger;
}
async function objects(net, method, options, ledger, check) {
  let marker;
  const seen = new Set();
  do {
    const page=await rpc(net,method,{account:net.issuer,ledger_hash:ledger.hash,limit:400,...options,marker});
    if (!page.validated || page.ledger_hash !== ledger.hash) throw Error('Inconsistent ledger');
    const found=check(page);
    if (found) return found;
    marker=page.marker;
    if (marker && seen.has(JSON.stringify(marker))) throw Error('Invalid pagination');
    seen.add(JSON.stringify(marker));
  } while (marker);
}
function eligible(offer, net, buyer, closeTime) {
  return offer?.LedgerEntryType === 'NFTokenOffer' && offer.Owner === net.issuer &&
    (offer.Flags & 1) === 1 && offer.Amount === PRICE && (!offer.Destination || offer.Destination === buyer) &&
    (!offer.Expiration || offer.Expiration > closeTime + 60) && ID.test(offer.NFTokenID) && ID.test(offer.index);
}
function decodeURI(hex) {
  if (!/^(?:[0-9a-fA-F]{2}){1,256}$/.test(hex)) return '';
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g),c=>parseInt(c,16)));
}
async function quote(net, buyer, origin, wanted) {
  const ledger=await snapshot(net);
  const l=await rpc(net,'ledger',{ledger_hash:ledger.hash,transactions:false});
  if (!l.validated || l.ledger.ledger_hash!==ledger.hash) throw Error('Invalid ledger');
  const close=l.ledger.close_time;
  const selection = [];
  if (wanted) {
    const result=await rpc(net,'ledger_entry',{index:wanted,ledger_hash:ledger.hash});
    if (!result || !result.validated || result.ledger_hash!==ledger.hash) return null;
    const row={...result.node,index:wanted};
    if (eligible(row,net,buyer,close)) selection.push(row);
  } else {
    await objects(net,'account_objects',{type:'nft_offer'},ledger,page=>{
      for (const row of page.account_objects) if (eligible(row,net,buyer,close)) selection.push(row);
      return false;
    });
  }
  if (!selection.length) return null;
  const offers=new Map(selection.map(row=>[row.NFTokenID,row]));
  return await objects(net,'account_nfts',{},ledger,page=>{
    for (const token of page.account_nfts) {
      const offer=offers.get(token.NFTokenID);
      if (!offer || token.Issuer!==net.issuer || token.NFTokenTaxon!==TAXON || token.Flags!==8) continue;
      const uri=decodeURI(token.URI);
      const prefix=origin+'/xrpl/metadata/';
      if (!uri.startsWith(prefix) || !/^\d{4}\.json$/.test(uri.slice(prefix.length))) continue;
      return {id:offer.index,token:token.NFTokenID,price:PRICE,ledger:ledger.seq,validThrough:ledger.seq+15};
    }
  }) || null;
}
async function receipt(net, hash, offer, buyer) {
  const tx=await rpc(net,'tx',{transaction:hash,binary:false});
  if (!tx || !tx.validated) return json({state:'pending'},202);
  const body=tx.tx_json;
  if (tx.hash!==hash || body?.TransactionType!=='NFTokenAcceptOffer' || body.Account!==buyer ||
      body.NFTokenSellOffer!==offer || body.NFTokenBuyOffer || body.NFTokenBrokerFee) return json({state:'mismatch'},409);
  if (tx.meta.TransactionResult!=='tesSUCCESS') return json({state:'failed',result:tx.meta.TransactionResult},409);
  const sale=tx.meta.AffectedNodes.find(n=>n.DeletedNode?.LedgerIndex===offer)?.DeletedNode;
  if (!sale || sale.LedgerEntryType!=='NFTokenOffer' || sale.FinalFields.Owner!==net.issuer ||
      sale.FinalFields.Amount!==PRICE || !(sale.FinalFields.Flags&1)) return json({state:'mismatch'},409);
  return json({state:'complete',hash,token:sale.FinalFields.NFTokenID,ledger:tx.ledger_index});
}
async function reconcile(net,buyer,offer,last) {
  if (!Number.isSafeInteger(last) || last < 16) return json({error:'Invalid ledger window'},400);
  const ledger=await snapshot(net);
  if (last>ledger.seq+16) return json({error:'Invalid ledger window'},400);
  const min=last-15, max=Math.min(last,ledger.seq);
  if (max<min) return json({state:'pending'},202);
  let marker;
  do {
    const page=await rpc(net,'account_tx',{account:buyer,ledger_index_min:min,ledger_index_max:max,
      forward:true,limit:200,marker});
    if (!page.validated || page.ledger_index_min>min || page.ledger_index_max<max)
      return json({state:'pending'},202);
    for (const item of page.transactions) {
      if (item.tx_json?.NFTokenSellOffer===offer && item.tx_json?.Account===buyer && ID.test(item.hash))
        return receipt(net,item.hash,offer,buyer);
    }
    marker=page.marker;
  } while (marker);
  return ledger.seq>last ? json({state:'expired'}) : json({state:'pending'},202);
}
async function openAsset(env,label,bytes) {
  const raw=Uint8Array.from(atob(env.ASSET_KEY),x=>x.charCodeAt(0));
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  const data=new Uint8Array(bytes);
  return crypto.subtle.decrypt({name:'AES-GCM',iv:data.subarray(0,12),additionalData:encoder.encode(label)},key,data.subarray(12));
}
async function retrieve(env, file, headers={}) {
  return env.ASSETS.fetch(new Request(internalOrigin+file,{headers}));
}
async function artwork(env, slot, entry) {
  const start=entry.offset, end=start+entry.length-1;
  const name='p'+String(Math.floor(Number(slot)/10)).padStart(3,'0')+'.bin';
  const asset=await retrieve(env,name,{Range:'bytes='+start+'-'+end});
  if (!asset.ok) throw Error('Artwork unavailable');
  let bytes=new Uint8Array(await asset.arrayBuffer());
  if (asset.status===206) {
    const range=asset.headers.get('Content-Range') || '';
    if (!range.startsWith('bytes '+start+'-'+end+'/')) throw Error('Wrong image range');
  } else if (asset.status===200) bytes=bytes.subarray(start,end+1);
  if (bytes.length!==entry.length) throw Error('Incomplete image');
  return openAsset(env,'art/'+slot,bytes);
}
async function metadata(env,path,origin,now) {
  const match=/^\/xrpl\/(metadata|art)\/(\d{4})\.(json|png)$/.exec(path);
  if (!match || (match[1]==='art')!==(match[3]==='png')) return response('','text/plain',404);
  const [,kind,slot]=match;
  if (now < REVEAL_AT) {
    if (kind==='art') return response('','text/plain',404);
    return json({name:'CoolBears #'+slot+' — Hidden Bear',description:'Your CoolBear is hiding.',image:origin+'/xrpl/cover.gif'});
  }
  const shard='m'+slot.slice(0,2)+'.json';
  const asset=await retrieve(env,shard);
  if (asset.status!==200) throw Error('Metadata unavailable');
  const rows=JSON.parse(new TextDecoder().decode(await openAsset(env,shard,await asset.arrayBuffer())));
  const row=rows[Number(slot.slice(2))];
  if (kind==='art') return response(await artwork(env,slot,row),'image/png');
  return json({name:row.name,description:row.description,attributes:row.attributes,image:origin+'/xrpl/art/'+slot+'.png',
    external_url:origin+'/xrpl/'});
}
export async function handle(request,env,now=Date.now()) {
  const url=new URL(request.url), path=url.pathname;
  env=siteEnvironment(url.hostname,env);
  if (!['GET','HEAD'].includes(request.method)) return response('','text/plain',405);
  try {
    let result;
    if (path==='/' || path==='/xrpl') return new Response(null,{status:302,headers:{Location:'/xrpl/','Cache-Control':'no-store'}});
    if (publicFiles.has(path)) {
      const [name,type]=publicFiles.get(path);const a=await retrieve(env,name);
      if (a.status!==200) throw Error('Site asset unavailable');
      result=response(a.body,type);
    } else if (path.startsWith('/xrpl/metadata/') || path.startsWith('/xrpl/art/')) {
      result=await metadata(env,path,url.origin,now);
    } else if (path==='/xrpl/api/status') {
      const net=network(env); result=json({network:net.name,issuer:net.issuer,open:env.SALES_OPEN==='yes',price:PRICE,revealAt:new Date(REVEAL_AT).toISOString()});
    } else if (path==='/xrpl/api/offer' || path==='/xrpl/api/receipt' || path==='/xrpl/api/reconcile') {
      const buyer=url.searchParams.get('buyer') || '', id=url.searchParams.get('offer');
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(buyer) || (id!==null && !ID.test(id))) return json({error:'Invalid request'},400);
      const net=network(env);
      if (path.endsWith('/reconcile')) {
        if (!id) return json({error:'Missing offer'},400);
        result=await reconcile(net,buyer,id,Number(url.searchParams.get('last')));
      } else if (path.endsWith('/receipt')) {
        const hash=url.searchParams.get('hash');
        if (!ID.test(hash) || !id) return json({error:'Invalid receipt'},400);
        result=await receipt(net,hash,id,buyer);
      } else {
        if (env.SALES_OPEN!=='yes') return json({error:'Sales closed'},409);
        const q=await quote(net,buyer,env.METADATA_ORIGIN || url.origin,id);
        result=q?json(q):json({error:'No eligible offer'},404);
      }
    } else return response('','text/plain',404);
    return request.method==='HEAD'?new Response(null,result):result;
  } catch (error) {console.error('CoolBears request failed',error.name,error.message);return json({error:'Temporarily unavailable'},503);}
}
export default {fetch:(request,env)=>handle(request,env)};
