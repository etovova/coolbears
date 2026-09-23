// Separate closed Devnet service. Submission is disabled unless explicitly built in.
import policy from '../../../metadata/policy.json' with {type:'json'};
import { PublicKey } from '@solana/web3.js';
import { createOrderModel } from '../journal-model.mjs';
import { createOrderPlanner } from '../transaction-model.mjs';
import { createAccountVerifier } from '../../deployment/accounts-model.mjs';
import { createOrderChecker } from '../preflight-model.mjs';
import {createCostQuote,costQuoteKey,validateCostApproval,enforceCostCeiling} from '../cost-approval.mjs';
import { anchorKey, validateBlockhashAnchor } from '../blockhash-anchor.mjs';
import { preparationFor, validatePreparation } from '../preparation.mjs';
import { validateAssetRequest } from '../signing.mjs';
import { validateBuyerSubmission, submissionBinding, signedBytesId } from '../submission.mjs';
import { recoverBuyerOrder } from '../recovery.mjs';
import {reviewBuyerExpiry} from '../review-expiry.mjs';
import {expiryKey,expiryRecord,restoreExpiryReport} from '../expiry-review.mjs';
import { createDeploymentRpc, assertCluster } from '../../deployment/rpc.mjs';
import { BuyerCheckError, need, exact, readJson } from './http.mjs';
const model=createOrderModel(policy),planner=createOrderPlanner(model);
const checker=createOrderChecker(policy,{...model,...planner,...createAccountVerifier(policy)});
const KEY='buyer-check-budget:v1',GLOBAL='buyer-check-global-v1',HOLD=45000,INTERVAL=200;
const METHODS=new Set(['getGenesisHash','getMultipleAccounts','getBalance','getFeeForMessage',
  'getMinimumBalanceForRentExemption','simulateTransaction','isBlockhashValid','getBlockHeight',
  'getSignatureStatuses','getTransaction','getLatestBlockhash']);
const EXPIRY_METHODS=new Set(['getBlock','getFirstAvailableBlock','getSignaturesForAddress']);
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','referrer-policy':'no-referrer'};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const reply=(status,value,extra={})=>new Response(JSON.stringify(value),{status,headers:{...HEADERS,...extra}});
function failure(error){const known=error instanceof BuyerCheckError;
  return reply(known?error.status:503,{status:'blocked',code:known?error.code:'CHECK_UNAVAILABLE',readyToSign:false,readyToSubmit:false,salesOpen:false},
    known&&integer(error.retryAfter)?{'retry-after':String(error.retryAfter)}:{});}
function cap(value,limit,fallback){if(value===undefined)return fallback;need(typeof value==='string'&&/^[1-9][0-9]*$/.test(value)&&+value<=limit,'CONFIGURATION',503);return +value;}
export function validateBuyerGatewayConfig(input){
  need(exact(input,'version cluster origin machine collection guard')&&input.version===1&&input.cluster==='devnet','CONFIGURATION',503);
  try{const u=new URL(input.origin);need(u.protocol==='https:'&&u.origin===input.origin&&!u.username&&!u.password,'CONFIGURATION',503);
    for(const field of ['machine','collection','guard'])need(new PublicKey(input[field]).toBase58()===input[field],'CONFIGURATION',503);
    need(new Set([input.machine,input.collection,input.guard]).size===3,'CONFIGURATION',503);
  }catch{throw new BuyerCheckError('CONFIGURATION',503);}
  return structuredClone(input);
}
function authorize(request,config,env){
  const u=new URL(request.url);need(u.origin===config.origin&&['/api/buyer/prepare','/api/buyer/check','/api/buyer/send','/api/buyer/recover','/api/buyer/review-expiry'].includes(u.pathname)&&!u.search&&!u.hash,'ROUTE',404);
  need(request.method==='POST','METHOD',405);
  need(request.headers.get('origin')===config.origin&&!request.headers.has('cookie')&&!request.headers.has('authorization')
    &&(!request.headers.has('sec-fetch-site')||request.headers.get('sec-fetch-site')==='same-origin'),'ORIGIN',403);
  need(typeof env.BUYER_HELIUS_API_KEY==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(env.BUYER_HELIUS_API_KEY),'CONFIGURATION',503);
}
function ledger(value,now){
  need(integer(now),'CLOCK',503);const day=Math.floor(now/86400000);
  if(value===undefined)return{version:1,day,checks:0,rpc:0,simulations:0,nextAt:0,holdUntil:0,cooldownUntil:0};
  need(exact(value,'version day checks rpc simulations nextAt holdUntil cooldownUntil')&&value.version===1
    &&Object.values(value).every(integer)&&value.simulations<=value.rpc,'LEDGER',503);
  return day>value.day?{...value,day,checks:0,rpc:0,simulations:0}:{...value};
}
function retryAfter(value,now){const s=typeof value==='string'&&/^\d+$/.test(value)?+value:Math.ceil((Date.parse(value)-now)/1000);return Number.isFinite(s)?Math.max(1,Math.min(300,s)):5;}
export function makeBuyerGateway(input,{allowSubmission=false}={}){
  need(typeof allowSubmission==='boolean','CONFIGURATION',503);
  const config=validateBuyerGatewayConfig(input);
  class BuyerCheckGate{
    constructor(state,env,{fetchImpl=(...args)=>globalThis.fetch(...args),clock=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
      this.storage=state.storage;this.env=env;this.fetchImpl=fetchImpl;this.clock=clock;this.pause=pause;this.busy=false;
    }
    async reserveCheck(){
      const daily=cap(this.env.DAILY_CHECK_CAP,500,100);
      await this.storage.transaction(async tx=>{
        const now=this.clock(),v=ledger(await tx.get(KEY),now),until=Math.max(v.nextAt,v.holdUntil,v.cooldownUntil);
        need(until<=now,'COOLDOWN',429,Math.max(1,Math.ceil((until-now)/1000)));
        need(v.checks<daily,'DAILY_LIMIT',429,Math.max(1,Math.ceil(((v.day+1)*86400000-now)/1000)));
        v.checks++;v.holdUntil=now+HOLD;await tx.put(KEY,v);
      });
    }
    async reserveRpc(method){
      const daily=cap(this.env.DAILY_RPC_CAP,5000,2000),sim=cap(this.env.DAILY_SIMULATION_CAP,500,100);
      const initial=ledger(await this.storage.get(KEY),this.clock()),wait=initial.nextAt-this.clock();
      need(wait<=INTERVAL,'COOLDOWN',429,Math.max(1,Math.ceil(wait/1000)));if(wait>0)await this.pause(wait);
      await this.storage.transaction(async tx=>{
        const now=this.clock(),v=ledger(await tx.get(KEY),now);
        need(v.holdUntil>now&&v.nextAt<=now,'LEASE',503);
        need(v.rpc<daily&&(method!=='simulateTransaction'||v.simulations<sim),'DAILY_LIMIT',429,86400);
        v.rpc++;if(method==='simulateTransaction')v.simulations++;v.nextAt=now+INTERVAL;await tx.put(KEY,v);
      });
    }
    async fetch(request){
      let own=false,reserved=false,settled=false,infra,sendBudgetReport;
      const started=performance.now(),route=new URL(request.url).pathname.split('/').at(-1);
      try{
        authorize(request,config,this.env);need(route!=='send'||allowSubmission,'SUBMISSION_DISABLED',403);need(!this.busy,'BUSY',429,1);this.busy=true;own=true;
        const body=await readJson(request,{signal:request.signal});
        need(exact(body,route==='prepare'?'version nonce order':route==='check'?'version nonce order claim request':route==='send'?'version nonce order claim request response costApproval':route==='review-expiry'?'version nonce order claim request response authorizeExpiryReview':'version nonce order claim request response')&&body.version===1&&typeof body.nonce==='string'&&/^[a-f0-9]{64}$/.test(body.nonce),'REQUEST',400);
        if(route==='review-expiry')need(body.authorizeExpiryReview===true,'EXPLICIT_EXPIRY_REVIEW_REQUIRED',400);
        const {order,claim,request:partial}=body;
        need(order&&['cluster','machine','collection','guard'].every(k=>order[k]===config[k]),'DEPLOYMENT_SCOPE',400);
        need(order.buyer===policy.owner,'SALES_CLOSED',409);
        const submission={order,claim,request:partial,response:body.response};
        let signed;
        try{
          if(route==='prepare'){model.validateOrder(order);need(order.revision===0&&!order.paused&&order.items.every(i=>i.attempts.length===0),'REQUEST',400);}
          else if(route!=='check')signed=validateBuyerSubmission(submission);
          else{validateAssetRequest(order,claim,partial);model.validateOrder(order);
          need(order.revision===1&&!order.paused&&order.items[0].attempts.length===1&&order.items[0].attempts[0].state==='wallet-pending'
            &&order.items.slice(1).every(item=>!item.attempts.length),'REQUEST',400);}
        }catch{throw new BuyerCheckError('REQUEST',400);}
        // Stable asset identity excludes order id/hash so a replay cannot evade a consumed send.
        const sendKey='buyer-send:v1:'+signedBytesId(JSON.stringify([config.cluster,config.machine,config.collection,config.guard,order.buyer,order.items[0].asset]));
        const retiredKey=expiryKey(order),retired=await this.storage.get(retiredKey);
        if(retired!==undefined){
          if(route==='review-expiry'){
            let report;try{report=restoreExpiryReport(submission,retired);}catch{throw new BuyerCheckError('EXPIRY_RECORD_CONFLICT',409);}
            return reply(200,{version:1,nonce:body.nonce,report});
          }
          need(route==='recover','ATTEMPT_EXPIRED',409);
        }
        if(route==='send'){
          need(!order.paused,'ORDER_PAUSED',409);
          need(await this.storage.get(sendKey)===undefined,'SEND_ALREADY_CLAIMED',409);
        }
        const blockKey=anchorKey(order),savedPreparation=route==='recover'?undefined:await this.storage.get(blockKey);
        if(route==='prepare'&&savedPreparation!==undefined){
          try{validatePreparation(order,savedPreparation);}catch{throw new BuyerCheckError('PREPARATION_CONFLICT',409);}
          return reply(200,{version:1,nonce:body.nonce,report:{status:'prepared',...savedPreparation,restored:true,readyToSign:false,readyToSubmit:false,salesOpen:false}});
        }
        if(['check','send','review-expiry'].includes(route)){
          try{validateBlockhashAnchor(savedPreparation?.anchor,claim);}catch{throw new BuyerCheckError('BLOCKHASH_ANCHOR_REQUIRED',409);}
        }
        if(route==='send'){
          try{validateCostApproval(body.costApproval,submission,{now:Date.now()});}
          catch(e){throw new BuyerCheckError(/^COST_[A-Z_]+$/.test(e.message)?e.message:'COST_APPROVAL_INVALID',409);}
          need(JSON.stringify(await this.storage.get(costQuoteKey(body.costApproval.quote.quoteId)))===JSON.stringify(body.costApproval.quote),'COST_QUOTE_NOT_SAVED',409);
        }
        await this.reserveCheck();reserved=true;
        if(route==='send')await this.storage.transaction(async tx=>{
          need(await tx.get(sendKey)===undefined,'SEND_ALREADY_CLAIMED',409);
          await tx.put(sendKey,{version:1,signature:signed.signature,transactionSha256:signedBytesId(signed.transactionBase64),costApproval:structuredClone(body.costApproval)});
        });
        const endpoint=new URL('https://devnet.helius-rpc.com/');endpoint.searchParams.set('api-key',this.env.BUYER_HELIUS_API_KEY);
        const fetchImpl=async(url,init)=>{
            try{
              const rpc=JSON.parse(init.body);need(url===endpoint.href&&(METHODS.has(rpc.method)||(route==='review-expiry'&&EXPIRY_METHODS.has(rpc.method))||(route==='send'&&allowSubmission&&rpc.method==='sendTransaction')),'RPC_METHOD',503);
              if(rpc.method==='sendTransaction'){
                need(performance.now()-started<30000,'CHECK_TOO_OLD',409);
                const consumed=await this.storage.get(sendKey);
                need(consumed?.signature===signed.signature&&consumed?.transactionSha256===signedBytesId(rpc.params[0])&&JSON.stringify(consumed.costApproval)===JSON.stringify(body.costApproval),'SEND_CLAIM',503);
              }
              await this.reserveRpc(rpc.method);need(!init.signal.aborted,'RPC_TIMEOUT',504);
              if(rpc.method==='sendTransaction'){try{enforceCostCeiling(body.costApproval,submission,sendBudgetReport);}catch{settled=true;throw new BuyerCheckError('COST_APPROVAL_EXPIRED',409);}}
              const response=await this.fetchImpl(url,{...init,redirect:'manual'});
              if([429,503].includes(response.status)){
                const seconds=retryAfter(response.headers.get('retry-after'),this.clock());
                await this.storage.transaction(async tx=>{const v=ledger(await tx.get(KEY),this.clock());v.cooldownUntil=Math.max(v.cooldownUntil,this.clock()+seconds*1000);await tx.put(KEY,v);});
                infra=new BuyerCheckError('UPSTREAM_UNAVAILABLE',response.status,seconds);
              }
              return response;
            }catch(error){infra=error instanceof BuyerCheckError?error:new BuyerCheckError('UPSTREAM_UNAVAILABLE',503);throw error;}
          };
        if(route==='prepare'){
          const rpc=createDeploymentRpc({endpoint:endpoint.href,fetchImpl,timeoutMs:12000,totalTimeoutMs:30000});
          await assertCluster(rpc,'devnet');
          const latest=await rpc.call('getLatestBlockhash',[{commitment:'confirmed'}]);
          need(integer(latest?.context?.slot),'RPC_CONTEXT',503);
          const record=preparationFor(order,latest.value,latest.context.slot);
          const height=await rpc.call('getBlockHeight',[{commitment:'confirmed',minContextSlot:record.anchor.sourceSlot}]);
          need(integer(height)&&record.anchor.lastValidBlockHeight-height>=80,'BLOCKHASH_TOO_OLD',409);
          need(performance.now()-started<30000,'CHECK_TOO_OLD',409);
          await this.storage.transaction(async tx=>{
            need(await tx.get(blockKey)===undefined,'PREPARATION_CONFLICT',409);await tx.put(blockKey,record);
          });
          need(JSON.stringify(await this.storage.get(blockKey))===JSON.stringify(record),'PREPARATION_UNCONFIRMED',503);
          settled=true;
          return reply(200,{version:1,nonce:body.nonce,report:{status:'prepared',...record,restored:false,readyToSign:false,readyToSubmit:false,salesOpen:false}});
        }
        if(route==='recover'){
          const report=await recoverBuyerOrder({input:submission,endpoint:endpoint.href,fetchImpl});
          settled=!report.code?.startsWith('RPC_');if(infra)throw infra;
          return reply(200,{version:1,nonce:body.nonce,report});
        }
        if(route==='review-expiry'){
          const report=await reviewBuyerExpiry({input:submission,blockhashAnchor:savedPreparation.anchor,endpoint:endpoint.href,fetchImpl});
          settled=!report.code?.startsWith('RPC_');if(infra)throw infra;
          if(report.status==='expired'){
            settled=false;need(performance.now()-started<30000,'CHECK_TOO_OLD',409);
            const record=expiryRecord(submission,report);
            await this.storage.transaction(async tx=>{need(await tx.get(retiredKey)===undefined,'EXPIRY_RECORD_CONFLICT',409);await tx.put(retiredKey,record);});
            need(JSON.stringify(await this.storage.get(retiredKey))===JSON.stringify(record),'EXPIRY_NOT_SAVED',503);
            settled=true;
          }
          return reply(200,{version:1,nonce:body.nonce,report});
        }
        const report=await checker[route==='send'?'checkSignedOrder':'checkPreparedOrder']({readOrder:()=>structuredClone(order),
          claim,request:partial,response:body.response,blockhashAnchor:savedPreparation.anchor,endpoint:endpoint.href,timeoutMs:12000,fetchImpl});
        // Keep the crash hold after uncertain transport/timeout or storage failure.
        settled=['wallet-check-passed','submission-check-passed'].includes(report.status)||(report.status==='blocked'&&!report.code?.startsWith('RPC_'));
        if(infra)throw infra;
        if(route==='send'&&report.status==='submission-check-passed'){
          settled=false;sendBudgetReport=report;
          try{enforceCostCeiling(body.costApproval,submission,report);}catch(e){settled=true;throw new BuyerCheckError(/^COST_[A-Z_]+$/.test(e.message)?e.message:'COST_APPROVAL_INVALID',409);}
          need(report.simulationMode==='signed'&&report.candidate.transactionBase64===signed.transactionBase64,'SIGNED_CHECK',409);
          const rpc=createDeploymentRpc({endpoint:endpoint.href,fetchImpl,timeoutMs:12000,totalTimeoutMs:15000,maxResponseBytes:16384,
            submission:{transactionBase64:signed.transactionBase64,minContextSlot:report.checkedSlot}});
          await assertCluster(rpc,'devnet');
          need(performance.now()-started<30000&&Date.now()<report.expiresAt,'CHECK_TOO_OLD',409);
          try{enforceCostCeiling(body.costApproval,submission,report);}catch{settled=true;throw new BuyerCheckError('COST_APPROVAL_EXPIRED',409);}
          await rpc.call('sendTransaction',[signed.transactionBase64,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot:report.checkedSlot}]);
          settled=true;
          return reply(200,{version:1,nonce:body.nonce,report:{...submissionBinding(submission),status:'accepted',cluster:'devnet',
            chainVerified:false,readyToSubmit:false,salesOpen:false,networkRequests:report.networkRequests+rpc.requests,
            costQuoteId:body.costApproval.quote.quoteId,maxTotalLamports:body.costApproval.maxTotalLamports,checkedTotalLamports:report.budget.nextItemKnownMinimumLamports}});
        }
        if(report.status!=='wallet-check-passed')return reply(409,{version:1,nonce:body.nonce,report});
        settled=false;
        const costQuote=createCostQuote({order,claim,request:partial},report),quoteKey=costQuoteKey(costQuote.quoteId);
        await this.storage.transaction(async tx=>{const previous=await tx.get(quoteKey);
          need(previous===undefined||JSON.stringify(previous)===JSON.stringify(costQuote),'COST_QUOTE_CONFLICT',503);await tx.put(quoteKey,costQuote);});
        need(JSON.stringify(await this.storage.get(quoteKey))===JSON.stringify(costQuote),'COST_QUOTE_NOT_SAVED',503);
        settled=true;
        return reply(200,{version:1,nonce:body.nonce,report:{...report,costQuote}});
      }catch(error){return failure(infra??error);}
      finally{
        if(own){
          try{if(reserved&&settled)await this.storage.transaction(async tx=>{const v=ledger(await tx.get(KEY),this.clock());v.holdUntil=0;await tx.put(KEY,v);});}
          catch{/* Keep the charged hold when release is uncertain. */}
          this.busy=false;
        }
      }
    }
  }
  return{BuyerCheckGate,worker:{async fetch(request,env){try{authorize(request,config,env);return await env.BUYER_CHECK_GATE.get(env.BUYER_CHECK_GATE.idFromName(GLOBAL)).fetch(request);}catch(error){return failure(error);}}}};
}
