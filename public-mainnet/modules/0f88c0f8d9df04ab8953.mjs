// Browser check transport: fixed same-origin path, no upstream URL or credential.
import { validateAssetRequest } from '/public-mainnet/modules/8c19f4e554421cc56f55.mjs';
import { validateWalletCheck } from '/public-mainnet/modules/567c67902474bc169c81.mjs';
import { BuyerCheckError, need, exact, readJson, BUYER_BODY_LIMIT } from '/public-mainnet/modules/8da7bb256a73d9c78c09.mjs';
export function createBuyerCheckClient({origin=globalThis.location?.origin,
  fetchImpl=(...args)=>globalThis.fetch(...args),crypto=globalThis.crypto,timeoutMs=35000}={}) {
  let endpoint;
  try{const url=new URL(origin);need(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password,'CONFIGURATION');endpoint=origin+'/api/buyer/check';}
  catch{throw new BuyerCheckError('CONFIGURATION');}
  need(typeof fetchImpl==='function'&&crypto?.getRandomValues&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=35000,'CONFIGURATION');
  return async input=>{
    need(exact(input,'order claim request'),'REQUEST');const value=structuredClone(input);
    validateAssetRequest(value.order,value.claim,value.request);
    const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const body=JSON.stringify({version:1,nonce,...value});need(new TextEncoder().encode(body).length<=BUYER_BODY_LIMIT,'BODY_SIZE');
    const controller=new AbortController();let timer,response;
    try{
      response=await Promise.race([fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body,
        signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',mode:'same-origin',referrerPolicy:'strict-origin'}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BuyerCheckError('CHECK_TIMEOUT'));},timeoutMs);})]);
      need(!response.redirected&&(!response.url||response.url===endpoint),'CHECK_REDIRECT',502);
      if(response.status!==200){
        let code='CHECK_HTTP';
        try{const failure=await readJson(response,{limit:2048,timeoutMs,signal:controller.signal,decodedResponse:true});
          const blocked=failure.status==='blocked'?failure:failure.version===1&&failure.nonce===nonce&&failure.report?.status==='blocked'?failure.report:null;
          if(blocked&&['COOLDOWN','BUSY','DAILY_LIMIT','INSUFFICIENT_BALANCE','ORIGIN','UPSTREAM_UNAVAILABLE','BLOCKHASH_TOO_OLD','BLOCKHASH_EXPIRED','ATTEMPT_EXPIRED','SIMULATION_FAILED','RPC_AMOUNT','FEE_UNAVAILABLE','BLOCKHASH_ANCHOR_REQUIRED','MINT_INDEX_CHANGED','CHECK_TOO_OLD','ATTEMPT_RECOVERED','ATTEMPT_FAILED','SALES_CLOSED','INSUFFICIENT_SUPPLY','RPC_RPC','RPC_CONTEXT'].includes(blocked.code))code=blocked.code;
          if(blocked===failure.report&&blocked?.code==='RPC_RPC'&&response.status===409&&['accounts','balance','cost','simulation','freshness'].includes(blocked.phase))code=blocked.phase==='freshness'?'QUOTE_FRESHNESS_RPC':'QUOTE_READ_RPC';
        }catch{}
        const header=response.headers.get('retry-after');
        const delay=response.status===429&&['COOLDOWN','BUSY'].includes(code)&&/^(?:[1-9]|[1-3][0-9]|4[0-5])$/.test(header??'')?Number(header):undefined;
        const error=new BuyerCheckError('CHECK_HTTP',response.status,delay);error.reason=code;throw error;
      }
      const result=await readJson(response,{limit:16384,timeoutMs,signal:controller.signal,decodedResponse:true});
      need(exact(result,'version nonce report')&&result.version===1&&result.nonce===nonce,'CHECK_RESPONSE',502);
      // A device clock can trail the check service slightly. Keep both ends
      // of the original validity window and still validate every report field.
      const ahead=result.report?.checkedAt-Date.now();
      if(Number.isSafeInteger(ahead)&&ahead>0&&ahead<=2000){
        validateWalletCheck(result.report,value.order,value.request,result.report.checkedAt);
        await new Promise(resolve=>setTimeout(resolve,ahead+10));
      }
      validateWalletCheck(result.report,value.order,value.request);return result.report;
    }catch(error){
      if(error instanceof BuyerCheckError)throw error;
      throw new BuyerCheckError(controller.signal.aborted?'CHECK_TIMEOUT':'CHECK_FAILED');
    }finally{clearTimeout(timer);controller.abort();try{void response?.body?.cancel().catch(()=>{});}catch{}}
  };
}
