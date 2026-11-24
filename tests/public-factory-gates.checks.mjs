import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
const root=new URL('../',import.meta.url),graphBytes=await readFile(new URL('public-mainnet/browser-assets.PRIVATE.json',root)),graph=JSON.parse(graphBytes),bindings=JSON.parse(await readFile(new URL('public-mainnet/browser-assets-binding.SAFE.json',root),'utf8'));
const pathRoute=path=>bindings.sourceBindings.find(row=>row.path===path).route;
const nativeCalls={},guarded=['create','prepare','quoteCost','sign','send','reviewReplacement','prepareReviewedReplacement'],readonly=['load','refresh','connectWallet','selectAccount','disconnectWallet','recover','recoverNative','recoverWalletResponse','reviewExpiry','setPaused','requestPersistence','startNew'];
const nativeState={scope:null,sendingEnabled:true,canCreate:true,canPrepare:true,canQuote:true,canSign:true,canSend:true,canRecover:true};
const native={state:()=>({...nativeState}),dispose:()=>{}};for(const name of [...guarded,...readonly])native[name]=async()=>{nativeCalls[name]=(nativeCalls[name]??0)+1;return{name};};
let journal={order:{items:[{attempts:[]}]}},reads=[];const mocks=new Map();for(const[path,name,value]of[
 ['operator/orders/browser-storage.mjs','createBuyerStorage',()=>({readBuyerSubmission:async scope=>{reads.push(scope.id);return undefined;},readRecoverySnapshot:async()=>journal})],
 ['operator/orders/wallet-client.mjs','createBuyerWalletClient',()=>({})],['operator/orders/gateway/preparation-client.mjs','createBuyerPreparationClient',()=>()=>{}],
 ['operator/orders/gateway/client.mjs','createBuyerCheckClient',()=>()=>{}],['operator/orders/gateway/submission-client.mjs','createBuyerSubmissionTransport',()=>({})],
 ['operator/orders/sender.mjs','createBuyerSender',()=>({})],['operator/orders/response-recovery-client.mjs','createBuyerResponseRecovery',()=>({})],
 ['operator/orders/prewallet-recovery-client.mjs','createBuyerPrewalletRecovery',()=>({})],['operator/orders/custody-recovery-client.mjs','createBuyerCustodyRecovery',()=>({})],
 ['operator/orders/buyer-console/controller.mjs','createPrivateBuyerController',options=>{assert.equal(options.sendingEnabled,true);native.state=()=>{options.index.list();return{...nativeState};};return native;}]
])mocks.set(pathRoute(path),{[name]:value});
let mode='closed',calls=0,config,release;
let now=Date.now();class SharedDate extends Date{static now(){return now;}}
const readinessWindow=(clock=SharedDate.now)=>{const checkedAt=clock();return{checkedAt,expiresAt:checkedAt+10000};};
const ctx=vm.createContext({console,Date:SharedDate,TextEncoder,TextDecoder,URL,Headers,Request,Response,Event,EventTarget,AbortController,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,atob,btoa,window:new EventTarget(),location:{origin:'https://coolbears-nfts.com'},navigator:{},localStorage:{getItem:()=>null},
 fetch:async(url,options)=>{calls++;assert.equal(url,'https://coolbears-nfts.com/api/buyer/readiness');assert.equal(options.credentials,'omit');if(mode==='error')throw Error('network');return new Response(JSON.stringify({...release,status:mode,salesOpen:mode==='open',...readinessWindow()}),{headers:{'content-type':'application/json'}});}});vm.runInContext('globalThis.self=globalThis;globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value));',ctx);
const modules=new Map();async function get(route){if(modules.has(route))return modules.get(route);let mod;if(mocks.has(route)){const values=mocks.get(route);mod=new vm.SyntheticModule(Object.keys(values),function(){for(const[name,value]of Object.entries(values))this.setExport(name,value);},{context:ctx,identifier:route});}else mod=new vm.SourceTextModule(graph.browserAssets[route],{context:ctx,identifier:route});modules.set(route,mod);return mod;}
const entry=new vm.SourceTextModule(`import config from '${pathRoute('public-mainnet/deployment.mjs')}';import {createPublicBuyerConsole} from '${pathRoute('public-mainnet/factory.mjs')}';import {validatePublicReadiness} from '${pathRoute('public-mainnet/readiness-client.mjs')}';export {config,createPublicBuyerConsole,validatePublicReadiness};`,{context:ctx});await entry.link(route=>get(route));await entry.evaluate();config=entry.namespace.config;
release={version:1,status:'closed',cluster:config.cluster,genesisHash:config.genesisHash,machine:config.machine,collection:config.collection,guard:config.guard,storageMode:config.storageMode,hiddenCommitmentSha256:config.hiddenCommitmentSha256,unitPriceLamports:'200000000',maximumPerOrder:50,profileSha256:config.profileSha256,...readinessWindow(),salesOpen:false};
const client=entry.namespace.createPublicBuyerConsole(config),cases=[];assert.equal(calls,0);assert.equal(client.state().salesOpen,false);assert.equal(client.state().canSend,false);cases.push({name:'fixed-public-factory-initially-closed-and-does-not-fetch-passively',passed:true});
let tick=now;const tickingClock=()=>tick++,oldWindow={checkedAt:tickingClock(),expiresAt:tickingClock()+10000},fixedWindow=readinessWindow(tickingClock);
assert.equal(oldWindow.expiresAt-oldWindow.checkedAt,10001);assert.throws(()=>entry.namespace.validatePublicReadiness({...release,...oldWindow},config,tick),/PUBLIC_READINESS_UNAVAILABLE/);
assert.equal(fixedWindow.expiresAt-fixedWindow.checkedAt,10000);assert.equal(entry.namespace.validatePublicReadiness({...release,...fixedWindow},config,tick).status,'closed');cases.push({name:'one-clock-capture-keeps-fixture-within-production-ten-second-freshness-limit',passed:true});
for(const name of guarded){await assert.rejects(()=>client[name](),/PUBLIC_SALES_CLOSED/);assert.equal(nativeCalls[name]??0,0);}assert.equal(calls,guarded.length);cases.push({name:'all-seven-financial-entrypoints-block-before-native-call-when-closed',passed:true});
mode='open';for(const name of guarded){const before=calls;await client[name]();assert.equal(calls,before+1);assert.equal(nativeCalls[name],1);}assert.equal(client.state().salesOpen,true);assert.equal(client.state().canSend,true);cases.push({name:'all-seven-financial-entrypoints-require-a-fresh-server-check',passed:true});
now+=10001;const stale=client.state();assert.equal(stale.readiness.expiredOpen,true);assert.equal(stale.salesOpen,false);
for(const key of ['canCreate','canPrepare','canQuote','canSign','canSend']){assert.equal(stale[key],false);assert.equal(stale.recheckActions[key],true);}
mode='closed';await assert.rejects(()=>client.create(),/PUBLIC_SALES_CLOSED/);assert.equal(nativeCalls.create,1);assert.equal(Object.keys(client.state().recheckActions).length,0);
cases.push({name:'expired-last-open-allows-only-a-recheck-and-never-forwards-after-closure',passed:true});
mode='error';for(const name of guarded){await assert.rejects(()=>client[name](),/PUBLIC_READINESS_UNAVAILABLE/);assert.equal(nativeCalls[name],1);}assert.equal(client.state().salesOpen,false);assert.equal(client.state().canSign,false);assert.equal(client.state().canSend,false);cases.push({name:'lost-readiness-response-revokes-old-open-evidence-and-never-forwards',passed:true});
const before=calls;for(const name of ['recover','recoverNative','recoverWalletResponse','reviewExpiry'])await client[name]();assert.equal(calls,before);for(const name of ['recover','recoverNative','recoverWalletResponse','reviewExpiry'])assert.equal(nativeCalls[name],1);cases.push({name:'read-only-custody-and-outcome-recovery-remain-available-when-closed',passed:true});
client.dispose();await assert.rejects(()=>client.send(),/PUBLIC_READINESS_UNAVAILABLE/);assert.equal(nativeCalls.send,1);cases.push({name:'disposed-public-factory-cannot-send',passed:true});
// Resume an existing, nonterminal record via the public start button. The wallet
// and sender must not run, but the factory must look up its persisted approval.
{
  mode='open';const buyer=config.machine, row={id:'kept-order',buyer};
  ctx.navigator.locks={request:async(_key,fn)=>fn()};
  ctx.localStorage.getItem=()=>JSON.stringify({version:1,orders:[row]});
  const was={load:native.load,selectAccount:native.selectAccount};
  native.load=async id=>{assert.equal(id,row.id);nativeState.scope=row;};
  native.selectAccount=async id=>{assert.equal(id,buyer);return native.state();};
  nativeState.selectedAccount=buyer;const restored=entry.namespace.createPublicBuyerConsole(config);
  const writes=[nativeCalls.create,nativeCalls.sign,nativeCalls.send];
  try{reads=[];await restored.create({quantity:1,authorizeCreate:true});assert.deepEqual(reads,[row.id]);
    assert.deepEqual([nativeCalls.create,nativeCalls.sign,nativeCalls.send],writes);
    assert.equal(restored.state().approvedQuote,null);
    cases.push({name:'automatic-resume-refreshes-the-current-order-approval-without-signing-or-sending',passed:true});
  }finally{restored.dispose();Object.assign(native,was);delete nativeState.selectedAccount;nativeState.scope=null;ctx.localStorage.getItem=()=>null;}
}
// Real public factory scans the persisted index again on a fresh visit.
{
 const buyer=config.machine,row={id:'old-scope',buyer};ctx.localStorage.getItem=()=>JSON.stringify({version:1,orders:[row]});
 const first={number:1,state:'expired',signature:null,lastValidBlockHeight:100,proof:{kind:'expired',signature:null,commitment:'finalized',blockhashValid:false,blockHeight:101,accountAbsent:true,signatureAbsent:true,addressHistoryEmpty:true}};
 const exact={readOnly:true,custody:{status:'available'},prewalletRecovery:{status:'expired',report:{status:'prewallet-expired',chainVerified:true}},
   order:{items:[{attempts:[first,{...first,number:2}]}]}};
 const saved={create:native.create,load:native.load,selectAccount:native.selectAccount};
 let created=0,restored=0;native.create=async a=>{assert.equal(a.quantity,2);created++;};
 native.load=async id=>{assert.equal(id,row.id);restored++;};native.selectAccount=async()=>{};
 nativeState.selectedAccount=buyer;const c=entry.namespace.createPublicBuyerConsole(config);
 try{journal=structuredClone(exact);await c.create({quantity:2,authorizeCreate:true});assert.equal(created,1);assert.equal(restored,0);
   for(const change of [r=>r.order.items[0].attempts.pop(),r=>r.order.items[0].attempts[1].proof.accountAbsent=false,r=>r.order.items[0].attempts[1].signature='possibly-signed',r=>r.prewalletRecovery=null,r=>r.order.items.push({attempts:[{state:'verified'}]}),r=>r.custody.status='unknown',r=>r.order.items[0].attempts[1].state='wallet-pending']){
     journal=structuredClone(exact);change(journal);await c.create({quantity:2,authorizeCreate:true});
   }assert.equal(created,1);assert.equal(restored,7);
   cases.push({name:'only-two-proven-unsigned-expiries-with-zero-receipts-unblock-fresh-order',passed:true});
   const afterPrompt=structuredClone(exact);
   delete afterPrompt.prewalletRecovery;
   afterPrompt.responseRecovery={status:'expired',report:{status:'response-expired',chainVerified:true}};
   journal=afterPrompt;
   await c.create({quantity:2,authorizeCreate:true});
   assert.equal(created,2,'two proven expirations must release an unanswered wallet order');
   for(const change of [
     r=>{r.responseRecovery.report.chainVerified=false;},
     r=>{r.responseRecovery.report.status='unknown';},
     r=>{r.order.items[0].attempts[0].proof.signatureAbsent=false;},
     r=>{r.order.items[0].attempts[1].proof.blockhashValid=true;}
   ]){
     journal=structuredClone(afterPrompt);change(journal);
     await c.create({quantity:2,authorizeCreate:true});
   }
   assert.equal(created,2);assert.equal(restored,11);
   cases.push({name:'two-finalized-unpaid-attempts-release-the-order-after-a-lost-wallet-response',passed:true});
   const start=()=>c.create({quantity:2,authorizeCreate:true,newPurchase:true});
   const draft={readOnly:true,custody:{status:'available'},order:{quantity:1,items:[{attempts:[{state:'unknown',signature:null}]}]},buyerWallet:{status:'wallet-response-unknown'}};
   const beforeCreates=created,beforeLoads=restored;
   journal=structuredClone(draft);await start();
   journal.order.quantity=2;await start();
   assert.equal(created,beforeCreates+2);assert.equal(restored,beforeLoads);
   journal.submission={status:'send-claimed'};await start();
   assert.equal(restored,beforeLoads+1);
   journal={...draft,order:{quantity:2,items:[{attempts:[]},{attempts:[]}]}};await start();
   assert.equal(restored,beforeLoads+2);
   cases.push({name:'storefront-keeps-selected-quantity-skips-unanswered-prompts-and-recognizes-in-flight-payments',passed:true});
 }finally{c.dispose();Object.assign(native,saved);delete nativeState.selectedAccount;ctx.localStorage.getItem=()=>null;}
}
const beforeBlocked=calls;vm.runInContext("Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});",ctx);const blockedClient=entry.namespace.createPublicBuyerConsole(config);assert.equal(blockedClient.state().storageAvailable,false);await blockedClient.connectWallet();assert.equal(nativeCalls.connectWallet,1);for(const name of guarded)await assert.rejects(()=>blockedClient[name](),/STORAGE_UNAVAILABLE/);assert.equal(calls,beforeBlocked);assert.equal(nativeCalls.create,1);blockedClient.dispose();cases.push({name:'blocked-browser-index-preserves-wallet-connection-and-blocks-finance-before-rpc',passed:true});
const factoryBytes=await readFile(new URL('public-mainnet/factory.mjs',root));const proof={version:1,passed:true,checksPassed:cases.length,checksFailed:0,cases,nativeCalls,readinessFetchCalls:calls,
 factory:{bytes:factoryBytes.length,sha256:createHash('sha256').update(factoryBytes).digest('hex')},graph:{bytes:graphBytes.length,sha256:createHash('sha256').update(graphBytes).digest('hex')},
 limitations:['Executed production public factory/readiness/config code and production static profile with synthetic native controller/storage/transport ports. These cases verify new authorization boundaries and do not attest custody, wallet signatures, actual RPC or successful purchases.','Existing native adapters and their algorithms remain unchanged; account verification is delegated to the separately tested public gateway.']};await writeFile(new URL('../build/public-mainnet/public-factory-gates-validation.SAFE.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:cases.length,readinessFetchCalls:calls,nativeCalls}));
