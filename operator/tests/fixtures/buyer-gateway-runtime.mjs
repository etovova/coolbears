// Test-only local workerd. Every external request is intercepted.
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
export const fixturePolicyPlugin=fixture=>({name:'disposable-owner-policy',setup(b){b.onLoad({filter:/metadata\/policy\.json$/},()=>({contents:JSON.stringify(fixture.policy),loader:'json'}));}});
export async function buyerGatewayRuntime({fixture,origin,persist,allowSubmission=false}){
  const root=path.resolve(new URL('../../..',import.meta.url).pathname),name='buyer-check-runtime';
  const bundled=await build({stdin:{contents:`import {makeBuyerGateway} from './operator/orders/gateway/worker.mjs';
const {worker,BuyerCheckGate}=makeBuyerGateway(${JSON.stringify(fixture.config(origin))},{allowSubmission:${allowSubmission}});
export {BuyerCheckGate}; export default worker;`,resolveDir:root,sourcefile:'buyer-gateway-fixture.mjs'},
    bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['node:*'],plugins:[fixturePolicyPlugin(fixture)]});
  const contents=bundled.outputFiles[0].text;
  assert.ok(!contents.includes('node:fs'));assert.ok(!contents.includes('buildDeploymentCostModel'));
  let mf;const errors=[];
  return{contents,errors,async start(extra={}){
    assert.equal(mf,undefined);
    mf=new Miniflare({telemetry:{enabled:false},cf:false,logRequests:false,resourcePersistencePath:persist,handleUncaughtError:e=>errors.push(e.message),workers:[{
      config:{name,compatibilityDate:'2026-09-23',compatibilityFlags:['nodejs_compat'],
        manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents}}},
        env:{...Object.fromEntries(Object.entries({BUYER_HELIUS_API_KEY:'fixture-secret-42',...extra}).map(([k,value])=>[k,{type:'text',value}])),
          BUYER_CHECK_GATE:{type:'durable-object',worker:name,exportName:'BuyerCheckGate'}},
        exports:{BuyerCheckGate:{type:'durable-object',storage:'sqlite'}}},
      dev:{outboundService:{type:'fetcher',handler:req=>fixture.upstream(req,RuntimeResponse)}}}]});await mf.ready;
    },async stop(){await mf?.dispose();mf=undefined;},dispatch:(url,init)=>mf.dispatchFetch(url,init),ids:()=>mf.listDurableObjectIds('BuyerCheckGate',name)};
}
