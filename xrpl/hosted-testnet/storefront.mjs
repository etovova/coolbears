import {authenticatedBuyer} from './xaman.mjs';
import {handle} from '../worker.mjs';
import app from '../web/app.js';
import {ISSUER, METADATA, ORIGIN, json} from './common.mjs';
const statusEnv={NETWORK:'testnet',SALES_OPEN:'yes',TEST_ISSUER:ISSUER,METADATA_ORIGIN:METADATA};

async function shortBody(req) {
  const reader=req.body?.getReader();
  if (!reader) return null;
  let length=0, chunks=[];
  for (;;) {
    const {done,value}=await reader.read();
    if (done) break;
    length+=value.byteLength;
    if (length>2048) {await reader.cancel();return null;}
    chunks.push(value);
  }
  return new Blob(chunks).text();
}
export default {
  async fetch(req,env) {
    const url=new URL(req.url), path=url.pathname;
    if (url.origin!==ORIGIN) return json({error:'Unknown host'},404);
    if (path==='/xrpl/app.js' && ['GET','HEAD'].includes(req.method))
      return new Response(req.method==='GET'?app:null,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    if (['/xrpl/api/mint','/xrpl/api/challenge'].includes(path)) {
      if (req.method!=='POST') return json({error:'POST required'},405);
      if (req.headers.get('Origin')!==ORIGIN || req.headers.get('Content-Type')?.split(';')[0]!=='application/json')
        return json({error:'Use the Testnet storefront'},403);
      const body=await shortBody(req);
      if (body===null) return json({error:'Invalid request size'},413);
      let input;
      try {input=JSON.parse(body);} catch {return json({error:'Invalid JSON'},400);}
      if (path==='/xrpl/api/challenge' && input?.provider==='xaman') {
        if (!env.XAMAN_CLIENT_ID) return json({error:'Xaman is not configured.'},503);
        try {
          if (!await authenticatedBuyer(req.headers.get('Authorization'),env.XAMAN_CLIENT_ID,input.buyer))
            return json({error:'Sign in with Xaman on XRPL Testnet.'},403);
        } catch { return json({error:'Xaman sign-in temporarily unavailable.'},503); }
        return env.ISSUANCE.fetch('https://orders.internal/xaman-challenge',{method:'POST',
          body:JSON.stringify({buyer:input.buyer,request:input.request})});
      }
      return env.ISSUANCE.fetch('https://orders.internal/'+path.split('/').pop(),{method:'POST',body});
    }
    if (path==='/xrpl/api/status' && ['GET','HEAD'].includes(req.method)) {
      const status=await (await handle(new Request(url),{...statusEnv,XAMAN_CLIENT_ID:env.XAMAN_CLIENT_ID,WALLETCONNECT_PROJECT_ID:env.WALLETCONNECT_PROJECT_ID})).json();
      const response=json({...status,mintMode:'collection'});
      return req.method==='HEAD'?new Response(null,response):response;
    }
    if (['/xrpl/api/offer','/xrpl/api/receipt','/xrpl/api/reconcile'].includes(path)) {
      if (path.endsWith('/offer') && !url.searchParams.get('offer'))
        return json({error:'Reserve a personal offer using the Mint button.'},409);
      const result=await handle(req,statusEnv);
      // Existing purchases from the preceding issuer keep their receipts and recovery windows.
      if (path.endsWith('/offer') && result.status===404) return env.LEGACY.fetch(req);
      if (result.status===409 && !path.endsWith('/offer')) return env.LEGACY.fetch(req);
      if (req.method==='GET' && result.status===200 && !path.endsWith('/offer')) {
        const r=await result.clone().json();
        if (r.state==='complete') {
          const saved=await env.ISSUANCE.fetch('https://orders.internal/receipt',{method:'POST',body:JSON.stringify({
            buyer:url.searchParams.get('buyer'),offer:url.searchParams.get('offer'),token:r.token,hash:r.hash})});
          if (!saved.ok) return json({state:'pending'},202);
        }
      }
      return result;
    }
    return env.LEGACY.fetch(req);
  }
};
