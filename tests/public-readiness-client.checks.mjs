import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validatePublicBuyerConfig} from '../public-mainnet/config.mjs';
import {validatePublicReadiness,createPublicReadinessClient} from '../public-mainnet/readiness-client.mjs';
const config={version:2,cluster:'mainnet-beta',origin:'https://coolbears-nfts.com',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  machine:'9emUPGVnUHLWC5bjT64GMEd3atc8wsP7SkMSNubwyKd8',collection:'9VywrMdDceBbUBxwsZvHqNt1MJy4Qw5MtTfy1eaavrHr',guard:'7gvbRthz7onxYz7Emqu78J38kpV8iFvsgUCymtD2DYrU',
  storageMode:'hidden-settings',hiddenCommitmentSha256:'8d0cc6977d821dae728699aef391eaf11ddbab475d13facf246cb86865b38a43',profileSha256:'c'.repeat(64)};
const base={version:1,status:'open',cluster:config.cluster,genesisHash:config.genesisHash,machine:config.machine,collection:config.collection,guard:config.guard,storageMode:config.storageMode,
  hiddenCommitmentSha256:config.hiddenCommitmentSha256,unitPriceLamports:'200000000',maximumPerOrder:50,profileSha256:config.profileSha256,checkedAt:1000,expiresAt:11000,salesOpen:true};
const cases=[];function pass(name){cases.push({name,passed:true});}
assert.equal(validatePublicBuyerConfig(config).profileSha256,config.profileSha256);assert.equal(validatePublicReadiness(base,config,1000).salesOpen,true);pass('exact-mainnet-profile-open-proof');
for(const[name,change]of[
 ['devnet',v=>v.cluster='devnet'],['crossed-genesis',v=>v.genesisHash='0'.repeat(44)],['machine-substitution',v=>v.machine=config.guard],['collection-substitution',v=>v.collection=config.guard],['guard-substitution',v=>v.guard=config.collection],
 ['crossed-profile',v=>v.profileSha256='b'.repeat(64)],['crossed-hidden-binding',v=>v.hiddenCommitmentSha256='b'.repeat(64)],['indexed-storage',v=>v.storageMode='config-lines'],
 ['wrong-price',v=>v.unitPriceLamports='500000000'],['wallet-limit-masquerading-as-order-limit',v=>v.maximumPerOrder=1],['future-proof',v=>v.checkedAt=1001],['stale-proof',v=>v.expiresAt=1000],
 ['long-lived-proof',v=>v.expiresAt=11001],['fractional-clock',v=>v.checkedAt=999.5],['open-false',v=>v.salesOpen=false],['closed-true',v=>v.status='closed'],['unknown-status',v=>v.status='confirmed'],
 ['extra-field',v=>v.localOverride=true],['missing-field',v=>delete v.profileSha256]
]){const value={...base};change(value);assert.throws(()=>validatePublicReadiness(value,config,1000),/PUBLIC_READINESS_UNAVAILABLE/);pass(name);}
for(const status of ['closed','sold-out','unavailable']){assert.equal(validatePublicReadiness({...base,status,salesOpen:false},config,1000).salesOpen,false);pass('valid-closed-state:'+status);}
assert.throws(()=>validatePublicBuyerConfig({...config,sendingEnabled:true}));assert.throws(()=>validatePublicBuyerConfig({...config,cluster:'devnet'}));pass('configuration-cannot-toggle-network-or-send');
let now=1000,calls=0,mode='open',defer;
const fetchImpl=async(url,options)=>{calls++;assert.equal(url,config.origin+'/api/buyer/readiness');assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,undefined);
 if(mode==='network-error')throw Error('provider response');if(mode==='deferred')return new Promise(resolve=>{defer=resolve;});
 return new Response(mode==='bad-json'?'not json':JSON.stringify({...base,status:mode,salesOpen:mode==='open',checkedAt:now,expiresAt:now+10000}),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});};
const client=createPublicReadinessClient(config,{fetchImpl,clock:()=>now,origin:config.origin});assert.equal(client.state().salesOpen,false);await client.requireOpen();assert.equal(calls,1);assert.equal(client.state().salesOpen,true);pass('fresh-open-required-on-every-financial-gate');
await client.requireOpen();assert.equal(calls,2);pass('no-financial-action-authorized-by-cached-boolean');now+=10000;assert.equal(client.state().salesOpen,false);pass('expires-without-server-response');
for(const value of ['closed','sold-out','unavailable','network-error','bad-json']){mode=value;await assert.rejects(()=>client.requireOpen());assert.equal(client.state().salesOpen,false);pass('request-fails-closed:'+value);}
mode='deferred';const pending=client.refresh(),second=client.requireOpen(),before=calls;assert.equal(client.state().salesOpen,false);await Promise.resolve();defer(new Response(JSON.stringify({...base,checkedAt:now,expiresAt:now+10000}),{headers:{'content-type':'application/json'}}));await pending;await second;assert.equal(calls,before);pass('one-entered-request-is-shared-without-duplicate-fetch');
mode='deferred';const stopping=client.refresh(),rejected=assert.rejects(stopping);await Promise.resolve();client.dispose();defer(new Response(JSON.stringify({...base,checkedAt:now,expiresAt:now+10000}),{headers:{'content-type':'application/json'}}));await rejected;assert.equal(client.state().salesOpen,false);pass('late-open-response-cannot-revive-disposed-client');
assert.throws(()=>createPublicReadinessClient(config,{origin:'https://other.example'}),/PUBLIC_ORIGIN/);pass('wrong-origin-blocked-before-fetch');
{
 let attempts=0;const test=createPublicReadinessClient(config,{origin:config.origin,clock:()=>1000,fetchImpl:async()=>{attempts++;return new Response(JSON.stringify({...base,status:attempts===1?'unavailable':'open',salesOpen:attempts!==1}),{headers:{'content-type':'application/json','x-coolbears-network-verified':attempts===1?'0':'1'}});}});
 assert.equal((await test.requireOpen()).status,'open');assert.equal(attempts,2);test.dispose();pass('transient-server-unavailability-rechecks-once-with-fresh-validated-proof');
}
for(const mode of ['network','bad-gateway','rate-limit','retry-after','wrong-chain']){
 let calls=0;const test=createPublicReadinessClient(config,{origin:config.origin,clock:()=>1000,fetchImpl:async()=>{calls++;
   if(calls===1&&mode==='network')throw new TypeError('synthetic mobile network interruption');
   if(calls===1&&['bad-gateway','rate-limit','retry-after'].includes(mode))return new Response('busy',{status:mode==='rate-limit'?429:503,headers:mode==='retry-after'?{'retry-after':'20'}:{}});
   return new Response(JSON.stringify({...base,...(mode==='wrong-chain'?{genesisHash:config.guard}:{})}),{headers:{'content-type':'application/json'}});
 }});
 if(['network','bad-gateway'].includes(mode)){await test.requireOpen();assert.equal(calls,2);}
 else{await assert.rejects(test.requireOpen());assert.equal(calls,1);assert.equal(test.state().salesOpen,false);}
 test.dispose();pass('transient-readiness-respects-fresh-proof-and-retry-limits:'+mode);
}
for(const reason of ['COOLDOWN','DAILY_LIMIT','PUBLIC_SALE_ACCOUNT_STATE']){
 let attempts=0;const gate=createPublicReadinessClient(config,{origin:config.origin,clock:()=>1000,fetchImpl:async()=>{attempts++;
 if(attempts===1)return new Response(JSON.stringify({...base,status:'unavailable',salesOpen:false}),{headers:{'content-type':'application/json','retry-after':reason==='DAILY_LIMIT'?'86400':'1','x-coolbears-network-verified':reason==='PUBLIC_SALE_ACCOUNT_STATE'?'1':'0','x-coolbears-readiness-reason':reason}});
 return Response.json(base);}});
 if(reason==='COOLDOWN'){await gate.requireOpen();assert.equal(attempts,2);}else{await assert.rejects(gate.requireOpen());assert.equal(attempts,1);}gate.dispose();pass('preserve-gateway-wait-and-daily-budget:'+reason);}
for(const mode of ['expires-in-transit','small-positive-skew','invalid-identity','excessive-skew','stale-repeatedly']){
 let t=20000,calls=0;const gate=createPublicReadinessClient(config,{origin:config.origin,clock:()=>t,fetchImpl:async()=>{
  calls++;const old=mode==='stale-repeatedly'||mode==='expires-in-transit'&&calls===1;
  if(mode==='small-positive-skew'&&calls===1)setTimeout(()=>{t+=25;},4);
  const c=old?t-8001:mode==='small-positive-skew'?t+10:mode==='excessive-skew'?t+90000:t-3;
  return Response.json({...base,checkedAt:c,expiresAt:c+8000,...(mode==='invalid-identity'?{guard:config.collection}:{})},{headers:{'x-coolbears-network-verified':'1'}});
 }});
 if(mode==='expires-in-transit'||mode==='small-positive-skew'){assert.equal((await gate.requireOpen()).status,'open');assert.equal(calls,mode==='expires-in-transit'?2:1);}
 else{await assert.rejects(gate.requireOpen());assert.equal(calls,mode==='stale-repeatedly'?2:1);assert.equal(gate.state().salesOpen,false);}
 gate.dispose();pass('strict-evidence-window:'+mode);}
const sources={};for(const name of ['config.mjs','readiness-client.mjs','factory.mjs','main.mjs','style.css']){const bytes=await readFile(new URL('../public-mainnet/'+name,import.meta.url));sources[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
const proof={version:1,passed:true,checksPassed:cases.length,checksFailed:0,cases,sources,liveRpcRequests:0,realWalletCalls:0,limitations:['Readiness client/config boundaries were executed with synthetic same-origin Response objects. This does not attest deployed readiness, actual accounts, Chromium, Phantom or a successful purchase.','A separately reviewed public gateway must recheck canonical public accounts before preparation, simulation and sending.']};await writeFile(new URL('../build/public-mainnet/public-readiness-client-validation.SAFE.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:cases.length}));
