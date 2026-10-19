// Test-only workerd/SQLite harness. Mutation access exists only in this generated
// local fixture worker, so corruption tests exercise the real durable storage.
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Response as RuntimeResponse} from 'miniflare';
import {fixturePolicyPlugin} from './buyer-gateway-runtime.mjs';
export async function buyerStorageRuntime({fixture,origin,persist,allowSubmission=false}){
  const root=path.resolve(new URL('../../..',import.meta.url).pathname),name='buyer-storage-runtime';
  const bundle=await build({stdin:{contents:`import {makeBuyerGateway} from './operator/orders/gateway/worker.mjs';
const built=makeBuyerGateway(${JSON.stringify(fixture.config(origin))},{allowSubmission:${allowSubmission}});
export class BuyerCheckGate extends built.BuyerCheckGate {
  async fetch(request){
    if(new URL(request.url).pathname!=='/fixture/storage')return super.fetch(request);
    const {operation,key,value}=await request.json();
    if(typeof key!=='string'||!key.startsWith('buyer-'))throw Error('fixture storage key');
    if(operation==='put')await this.storage.put(key,value);
    else if(operation==='delete')await this.storage.delete(key);
    else if(operation!=='get')throw Error('fixture storage operation');
    const saved=await this.storage.get(key);
    return Response.json({present:saved!==undefined,value:saved??null});
  }
}
export default {fetch(request,env){
  return new URL(request.url).pathname==='/fixture/storage'
    ?env.BUYER_CHECK_GATE.get(env.BUYER_CHECK_GATE.idFromName('buyer-check-global-v1')).fetch(request)
    :built.worker.fetch(request,env);
}};`,resolveDir:root,sourcefile:'buyer-storage-fixture.mjs'},bundle:true,write:false,platform:'browser',format:'esm',
    target:'es2022',external:['node:*'],plugins:[fixturePolicyPlugin(fixture)]});
  const contents=bundle.outputFiles[0].text;assert.ok(!contents.includes('node:fs'));
  let mf;const errors=[];
  return{errors,async start(extra={}){
    assert.equal(mf,undefined);
    mf=new Miniflare({telemetry:{enabled:false},cf:false,logRequests:false,resourcePersistencePath:persist,
      handleUncaughtError:error=>errors.push(error.message),workers:[{
        config:{name,compatibilityDate:'2026-09-23',compatibilityFlags:['nodejs_compat'],
          manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents}}},
          env:{...Object.fromEntries(Object.entries({BUYER_HELIUS_API_KEY:'fixture-secret-42',...extra}).map(([key,value])=>[key,{type:'text',value}])),
            BUYER_CHECK_GATE:{type:'durable-object',worker:name,exportName:'BuyerCheckGate'}},
          exports:{BuyerCheckGate:{type:'durable-object',storage:'sqlite'}}},
        dev:{outboundService:{type:'fetcher',handler:request=>fixture.upstream(request,RuntimeResponse)}}}]});
    await mf.ready;
  },async stop(){await mf?.dispose();mf=undefined;},dispatch:(url,init)=>mf.dispatchFetch(url,init),
  ids:()=>mf.listDurableObjectIds('BuyerCheckGate',name),async storage(operation,key,value){
    const response=await mf.dispatchFetch(origin+'/fixture/storage',{method:'POST',body:JSON.stringify({operation,key,...(value===undefined?{}:{value})})});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  }};
}
