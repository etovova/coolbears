// Fixed HTTPS transport for explicit send and read-only recovery. No retries.
import {BuyerCheckError,need,exact,readJson} from './http.mjs';
import {validateCostApproval,lamports} from '../cost-approval.mjs';
import {validateBuyerSubmission,validateBuyerResult} from '../submission.mjs';
import {validateBuyerExpiryResult} from '../expiry-review.mjs';
import {validateReplacementSource,validateReplacementResult} from '../replacement.mjs';
export function createBuyerSubmissionTransport({origin=globalThis.location?.origin,fetchImpl=(...a)=>globalThis.fetch(...a),crypto=globalThis.crypto,timeoutMs=35000}={}){
  try{const u=new URL(origin);need(u.protocol==='https:'&&u.origin===origin&&!u.username&&!u.password,'CONFIGURATION');}catch{throw new BuyerCheckError('CONFIGURATION');}
  need(typeof fetchImpl==='function'&&crypto?.getRandomValues&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=35000,'CONFIGURATION');
  async function call(route,input,costApproval,acknowledgedFeeLamports){
    need(exact(input,'order claim request response'),'REQUEST');const value=structuredClone(input);
    if(route==='replace')validateReplacementSource(value);else validateBuyerSubmission(value);
    const approval=route==='send'?structuredClone(costApproval):undefined;
    if(route==='send')validateCostApproval(approval,value,{now:Date.now()});
    const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const body=JSON.stringify({version:1,nonce,...value,...(route==='send'?{costApproval:approval}:route==='review-expiry'?{authorizeExpiryReview:true}:route==='replace'?{authorizeReplacement:true,...(acknowledgedFeeLamports!==undefined?{acknowledgedFeeLamports}:{})}:{})});need(new TextEncoder().encode(body).length<=65536,'BODY_SIZE');
    const endpoint=origin+'/api/buyer/'+route,controller=new AbortController();let timer,response;
    try{
      response=await Promise.race([fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body,signal:controller.signal,
        redirect:'error',credentials:'omit',cache:'no-store',mode:'same-origin',referrerPolicy:'no-referrer'}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BuyerCheckError('SUBMISSION_TIMEOUT'));},timeoutMs);})]);
      need(!response.redirected&&(!response.url||response.url===endpoint),'SUBMISSION_REDIRECT',502);
      need(response.status===200,'SUBMISSION_HTTP',response.status);
      const result=await readJson(response,{limit:16384,timeoutMs,signal:controller.signal});
      need(exact(result,'version nonce report')&&result.version===1&&result.nonce===nonce,'SUBMISSION_RESPONSE',502);
      const report=route==='replace'?validateReplacementResult(result.report,value):route==='review-expiry'?validateBuyerExpiryResult(result.report,value):validateBuyerResult(result.report,value,{recovery:route==='recover'});
      if(route==='replace')need(report.record.acknowledgedFeeLamports===acknowledgedFeeLamports,'REPLACEMENT_BINDING',502);
      if(route==='send')need(report.costQuoteId===approval.quote.quoteId&&report.maxTotalLamports===approval.maxTotalLamports
        &&lamports(report.checkedTotalLamports)>0n&&lamports(report.checkedTotalLamports)<=lamports(approval.maxTotalLamports),'COST_RESPONSE',502);
      return report;
    }catch(error){if(error instanceof BuyerCheckError)throw error;throw new BuyerCheckError(controller.signal.aborted?'SUBMISSION_TIMEOUT':'SUBMISSION_FAILED');}
    finally{clearTimeout(timer);controller.abort();try{void response?.body?.cancel().catch(()=>{});}catch{}}
  }
  return Object.freeze({send:(input,approval)=>call('send',input,approval),recover:input=>call('recover',input),reviewExpiry:input=>call('review-expiry',input),replace:(input,{acknowledgedFeeLamports}={})=>call('replace',input,undefined,acknowledgedFeeLamports)});
}
