// Fixed overlay of the current site; original static assets remain in ASSETS.
// No request or environment value selects a release or opens a guard.
const HEADERS={'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','referrer-policy':'no-referrer'};
const sha256=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers:{...HEADERS,'content-type':'application/json; charset=utf-8'}});
const key=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function makePublicSiteRuntime({origin,profileSha256,sourcePolicySha256,buildSha256,overlay,originalAssets,buyerWorker}){
 if(origin!=='https://coolbears-nfts.com'||![profileSha256,sourcePolicySha256,buildSha256].every(key)
   ||!overlay||!originalAssets||Object.keys(originalAssets).length!==3||typeof buyerWorker?.fetch!=='function')throw Error('PUBLIC_SITE_BUILD');
 const entries=new Map();
 for(const [route,value]of Object.entries(overlay)){
  if(!/^(?:\/|\/index\.html|\/app\.js|\/public-mainnet\/[A-Za-z0-9_./-]+)$/.test(route)||route.split('/').includes('..')
    ||!value||typeof value.body!=='string'||!['text/javascript; charset=utf-8','text/css; charset=utf-8','text/plain; charset=utf-8','text/html; charset=utf-8'].includes(value.contentType))throw Error('PUBLIC_SITE_BUILD');
  entries.set(route,Object.freeze({...value}));
 }
 let assetProof=null;
 async function originalProof(env){
  if(assetProof)return assetProof;
  const work=(async()=>{
   const assets={};
   for(const [route,expected]of Object.entries(originalAssets)){
    if(!/^\/assets\/collection\/(?:logo\.png|banner\.png|gif\.gif)$/.test(route)||!key(expected.sha256)||!Number.isSafeInteger(expected.bytes)||expected.bytes<1||expected.bytes>5000000)throw Error('PUBLIC_SITE_ASSET');
    const response=await env.ASSETS.fetch(new Request(origin+route,{redirect:'manual',credentials:'omit'}));
    if(response.status!==200)throw Error('PUBLIC_SITE_ASSET');
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==expected.bytes||await sha256(bytes)!==expected.sha256)throw Error('PUBLIC_SITE_ASSET');
    assets[route]={bytes:bytes.byteLength,sha256:expected.sha256};
   }
   return assets;
  })();
  assetProof=work;
  try{return await work;}catch(error){if(assetProof===work)assetProof=null;throw error;}
 }
 return Object.freeze({async fetch(request,env,ctx){
  try{
   const url=new URL(request.url);
   if(url.origin!==origin)return reply(404,{status:'unavailable'});
   if(url.pathname==='/api/buyer/deployment'){
    if(request.method!=='GET'||url.search||url.hash||request.headers.has('cookie')||request.headers.has('authorization')
      ||(request.headers.has('origin')&&request.headers.get('origin')!==origin)
      ||(request.headers.has('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin'))return reply(403,{status:'unavailable'});
    const preservedAssets=await originalProof(env);
    const network=await buyerWorker.fetch(new Request(origin+'/api/buyer/readiness',{method:'GET',redirect:'manual',credentials:'omit'}),env,ctx);
    if(network.status!==200||network.headers.get('x-coolbears-network-verified')!=='1')throw Error('PUBLIC_SITE_NETWORK');
    return reply(200,{version:1,kind:'coolbears-public-site-deployment',buildSha256,profileSha256,sourcePolicySha256,preservedAssets,originalAssetsVerified:true});
   }
   if(url.pathname.startsWith('/api/buyer/'))return await buyerWorker.fetch(request,env,ctx);
   const item=entries.get(url.pathname);
   if(item){
    const pinnedAppQuery=url.pathname==='/app.js'&&['?v=wallet-reliability-20260922-2','?v=public-mainnet-20261018-1'].includes(url.search);
    if(!['GET','HEAD'].includes(request.method)||(url.search&&!pinnedAppQuery)||url.hash)return reply(404,{status:'unavailable'});
    return new Response(request.method==='HEAD'?null:item.body,{headers:{...HEADERS,'content-type':item.contentType}});
   }
   return await env.ASSETS.fetch(request);
  }catch{return reply(503,{status:'unavailable',salesOpen:false});}
 }});
}
