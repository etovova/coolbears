// Separate closed Devnet check service. No arbitrary RPC, signing or submission.
import policy from '../../../metadata/policy.json' with {type:'json'};
import { PublicKey } from '@solana/web3.js';
import { createOrderModel } from '../journal-model.mjs';
import { createOrderPlanner } from '../transaction-model.mjs';
import { createAccountVerifier } from '../../deployment/accounts-model.mjs';
import { createOrderChecker } from '../preflight-model.mjs';
import { validateAssetRequest } from '../signing.mjs';
import { BuyerCheckError, need, exact, readJson } from './http.mjs';
const model=createOrderModel(policy),planner=createOrderPlanner(model);
const checker=createOrderChecker(policy,{...model,...planner,...createAccountVerifier(policy)});
const KEY='buyer-check-budget:v1',GLOBAL='buyer-check-global-v1',HOLD=45000,INTERVAL=200;
const METHODS=new Set(['getGenesisHash','getMultipleAccounts','getBalance','getFeeForMessage',
  'getMinimumBalanceForRentExemption','simulateTransaction','isBlockhashValid','getBlockHeight']);
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
  const u=new URL(request.url);need(u.origin===config.origin&&u.pathname==='/api/buyer/check'&&!u.search&&!u.hash,'ROUTE',404);
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
export function makeBuyerGateway(input){
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
      let own=false,reserved=false,settled=false,infra;
      try{
        authorize(request,config,this.env);need(!this.busy,'BUSY',429,1);this.busy=true;own=true;
        const body=await readJson(request,{signal:request.signal});
        need(exact(body,'version nonce order claim request')&&body.version===1&&typeof body.nonce==='string'&&/^[a-f0-9]{64}$/.test(body.nonce),'REQUEST',400);
        const {order,claim,request:partial}=body;
        need(order&&['cluster','machine','collection','guard'].every(k=>order[k]===config[k]),'DEPLOYMENT_SCOPE',400);
        need(order.buyer===policy.owner,'SALES_CLOSED',409);
        try{validateAssetRequest(order,claim,partial);model.validateOrder(order);
          need(order.revision===1&&!order.paused&&order.items[0].attempts.length===1&&order.items[0].attempts[0].state==='wallet-pending'
            &&order.items.slice(1).every(item=>!item.attempts.length),'REQUEST',400);
        }catch{throw new BuyerCheckError('REQUEST',400);}
        await this.reserveCheck();reserved=true;
        const endpoint=new URL('https://devnet.helius-rpc.com/');endpoint.searchParams.set('api-key',this.env.BUYER_HELIUS_API_KEY);
        const report=await checker.checkPreparedOrder({readOrder:()=>structuredClone(order),claim,request:partial,endpoint:endpoint.href,timeoutMs:12000,
          fetchImpl:async(url,init)=>{
            try{
              const rpc=JSON.parse(init.body);need(url===endpoint.href&&METHODS.has(rpc.method),'RPC_METHOD',503);
              await this.reserveRpc(rpc.method);need(!init.signal.aborted,'RPC_TIMEOUT',504);
              const response=await this.fetchImpl(url,{...init,redirect:'manual'});
              if([429,503].includes(response.status)){
                const seconds=retryAfter(response.headers.get('retry-after'),this.clock());
                await this.storage.transaction(async tx=>{const v=ledger(await tx.get(KEY),this.clock());v.cooldownUntil=Math.max(v.cooldownUntil,this.clock()+seconds*1000);await tx.put(KEY,v);});
                infra=new BuyerCheckError('UPSTREAM_UNAVAILABLE',response.status,seconds);
              }
              return response;
            }catch(error){infra=error instanceof BuyerCheckError?error:new BuyerCheckError('UPSTREAM_UNAVAILABLE',503);throw error;}
          }});
        // Keep the crash hold after uncertain transport/timeout or storage failure.
        settled=report.status==='wallet-check-passed'||(report.status==='blocked'&&!report.code?.startsWith('RPC_'));
        if(infra)throw infra;
        if(report.status!=='wallet-check-passed')return reply(409,{version:1,nonce:body.nonce,report});
        return reply(200,{version:1,nonce:body.nonce,report});
      }catch(error){return failure(error);}
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
