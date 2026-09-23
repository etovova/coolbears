// Browser unsigned preparation transport: fixed same-origin path, no upstream URL or credential.
import { validatePreparation } from '../preparation.mjs';
import { BuyerCheckError, need, exact, readJson } from './http.mjs';
export function createBuyerPreparationClient({origin=globalThis.location?.origin,
  fetchImpl=(...args)=>globalThis.fetch(...args),crypto=globalThis.crypto,timeoutMs=35000}={}) {
  let endpoint;
  try{const url=new URL(origin);need(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password,'CONFIGURATION');endpoint=origin+'/api/buyer/prepare';}
  catch{throw new BuyerCheckError('CONFIGURATION');}
  need(typeof fetchImpl==='function'&&crypto?.getRandomValues&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=35000,'CONFIGURATION');
  return async input=>{
    need(exact(input,'order'),'REQUEST');const value=structuredClone(input);

    const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const body=JSON.stringify({version:1,nonce,...value});need(new TextEncoder().encode(body).length<=65536,'BODY_SIZE');
    const controller=new AbortController();let timer,response;
    try{
      response=await Promise.race([fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body,
        signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',mode:'same-origin',referrerPolicy:'no-referrer'}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BuyerCheckError('CHECK_TIMEOUT'));},timeoutMs);})]);
      need(!response.redirected&&(!response.url||response.url===endpoint),'CHECK_REDIRECT',502);
      need(response.status===200,'CHECK_HTTP',response.status);
      const result=await readJson(response,{limit:16384,timeoutMs,signal:controller.signal});
      need(exact(result,'version nonce report')&&result.version===1&&result.nonce===nonce,'CHECK_RESPONSE',502);
      const report=result.report;
      need(exact(report,'status anchor candidate restored readyToSign readyToSubmit salesOpen')&&report.status==='prepared'
        &&typeof report.restored==='boolean'&&report.readyToSign===false&&report.readyToSubmit===false&&report.salesOpen===false,'CHECK_RESPONSE',502);
      validatePreparation(value.order,{anchor:report.anchor,candidate:report.candidate});return report;
    }catch(error){
      if(error instanceof BuyerCheckError)throw error;
      throw new BuyerCheckError(controller.signal.aborted?'CHECK_TIMEOUT':'CHECK_FAILED');
    }finally{clearTimeout(timer);controller.abort();try{void response?.body?.cancel().catch(()=>{});}catch{}}
  };
}
