import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
const root=new URL('../',import.meta.url),graphBytes=await readFile(new URL('public-mainnet/browser-assets.PRIVATE.json',root)),graph=JSON.parse(graphBytes),binding=JSON.parse(await readFile(new URL('public-mainnet/browser-assets-binding.SAFE.json',root),'utf8'));
function dom(){
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.hidden=false;this.disabled=false;this.checked=false;this.value='';this._text='';this.open=false;}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(value=>value.textContent).join('');}
    set innerHTML(html){this._text='';this.children=[];const stack=[this];for(const token of html.matchAll(/<\/?[^>]+>|[^<]+/g)){const value=token[0];if(value.startsWith('</')){stack.pop();continue;}if(value.startsWith('<')){const tag=/^<([^\s/>]+)/.exec(value)?.[1];if(!tag)continue;const node=new Element(tag);for(const a of value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){if(a.index===1)continue;node.setAttribute(a[1],a[2]??'');}stack.at(-1).append(node);if(!['input','meta','link','br'].includes(tag))stack.push(node);}else stack.at(-1)._text+=value;}}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=value;if(name==='class')this.className=value;if(name==='hidden')this.hidden=true;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
    getAttribute(name){return this.attributes[name]??(name.startsWith('data-')?this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:undefined)??null;}removeAttribute(name){delete this.attributes[name];}
    append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
    insertAdjacentElement(position,node){assert.equal(position,'afterend');const i=this.parent.children.indexOf(this);node.parent=this.parent;this.parent.children.splice(i+1,0,node);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
    querySelector(selector){return this.all().find(node=>matches(node,selector))??null;}querySelectorAll(selector){return this.all().filter(node=>matches(node,selector));}
    all(){return this.children.flatMap(node=>[node,...node.all()]);}get options(){return this.children;}addEventListener(name,fn){const rows=this.listeners.get(name)??[];rows.push(fn);this.listeners.set(name,rows);}removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)??[]).filter(x=>x!==fn));}
    showModal(){this.open=true;}close(){this.open=false;for(const fn of this.listeners.get('close')??[])fn();}async click(){if(this.disabled)return;await this.onclick?.();for(const fn of this.listeners.get('click')??[])await fn();}
  }
  function matches(node,selector){if(selector.startsWith('#'))return node.id===selector.slice(1);if(selector.startsWith('.'))return node.className?.split(' ').includes(selector.slice(1));const attribute=/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);if(attribute)return(!attribute[1]||node.tagName===attribute[1])&&(attribute[3]===undefined?Object.hasOwn(node.attributes,attribute[2])||attribute[2].startsWith('data-')&&Object.hasOwn(node.dataset,attribute[2].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())):node.getAttribute(attribute[2])===attribute[3]);return node.tagName===selector;}
  const head=new Element('head'),body=new Element('body'),document={head,body,createElement:tag=>new Element(tag),querySelector:selector=>head.querySelector(selector)??body.querySelector(selector),getElementById:id=>head.querySelector('#'+id)??body.querySelector('#'+id)};
  for(const[id,tag]of[['minted','strong'],['mintBtn','button'],['walletBtn','button'],['qty','input'],['public-test-copy','section']]){const el=new Element(tag);el.id=id;body.append(el);}document.getElementById('qty').value='50';
  for(const name of ['mintTitle','mintNow','heroText']){const el=new Element('p');el.setAttribute('data-i18n',name);body.append(el);}return document;
}
async function load(){let fetches=0;const timers=new Set(),sandbox={console,TextEncoder,TextDecoder,URL,Headers,Request,Response,Event,EventTarget,AbortController,AbortSignal,crypto:webcrypto,CryptoKey:webcrypto.CryptoKey,atob,btoa,location:{origin:'https://coolbears-nfts.com'},navigator:{storage:{persisted:async()=>false}},window:new EventTarget(),fetch:()=>{fetches++;throw Error('UNEXPECTED_FETCH');},setTimeout(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn();},ms===45200?5:ms);timers.add(t);return t;},clearTimeout(t){timers.delete(t);clearTimeout(t);}};
 const ctx=vm.createContext(sandbox);vm.runInContext('globalThis.self=globalThis;globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value));',ctx);const modules=new Map();async function get(route){if(modules.has(route))return modules.get(route);const mod=new vm.SourceTextModule(graph.browserAssets[route],{context:ctx,identifier:route});modules.set(route,mod);return mod;}
 const entry=new vm.SourceTextModule(graph.browserAsset,{context:ctx});await entry.link(route=>get(route));await entry.evaluate();const mod=modules.get(binding.sourceBindings.find(row=>row.path==='public-mainnet/main.mjs').route);
 return{mount:mod.namespace.mountPublicMint,config:modules.get(binding.sourceBindings.find(row=>row.path==='public-mainnet/deployment.mjs').route).namespace.default,fetches:()=>fetches,stop(){for(const timer of timers)clearTimeout(timer);}};
}
const counts={ready:0,connect:0,persist:0,create:0,prepare:0,quote:0,sign:0,send:0,recover:0,saveResponse:0};
const buyer='11111111111111111111111111111112',account={address:buyer,publicKey:Object.assign(new Uint8Array(32),{31:1}),chains:['solana:mainnet'],features:['solana:signTransaction']};
const wallet={name:'Synthetic buyer wallet',chains:['solana:mainnet'],accounts:[account],features:{'standard:connect':{connect:async()=>{counts.connect++;}},'standard:events':{on:()=>()=>{}},'solana:signTransaction':{signTransaction:async()=>{throw Error('MOCK_PORT_MUST_OWN_SIGNATURE');},supportedTransactionVersions:[0]}}};
let state={salesOpen:false,saleStatus:'unavailable',busy:false,saved:[],scope:null,accounts:[],selectedAccount:null},change;
const emit=()=>change({...state}),client={state:()=>({...state}),refreshReadiness:async()=>{counts.ready++;state={...state,salesOpen:true,saleStatus:'open',canCreate:!!state.selectedAccount};emit();},
 connectWallet:async selected=>{await selected.features['standard:connect'].connect();state={...state,accounts:[account]};emit();},selectAccount:async value=>{assert.equal(value,buyer);state={...state,selectedAccount:value,canCreate:state.salesOpen};emit();},disconnectWallet:()=>{state={...state,accounts:[],selectedAccount:null,canCreate:false};emit();},
 requestPersistence:async value=>{assert.equal(value.authorizePersistence,true);counts.persist++;},
 create:async value=>{assert.equal(value.quantity,50);assert.equal(value.authorizeCreate,true);counts.create++;state={...state,scope:{id:'synthetic-order',buyer},quantity:50,verified:0,canCreate:false,canPrepare:true};emit();},
 prepare:async value=>{assert.equal(value.authorizePreparation,true);counts.prepare++;state={...state,canPrepare:false,canQuote:true};emit();},
 quoteCost:async()=>{counts.quote++;state={...state,canSign:true,quote:{quoteId:'c'.repeat(64),budget:{unitPriceLamports:'200000000',networkFeeLamports:'10000',assetRentLamports:'1500000',protocolChargeLamports:'1500000',totalLamports:'203010000',projectedOrderTotalLamports:'10150500000'}}};emit();},
 sign:async value=>{assert.equal(value.authorizeCost,true);assert.equal(value.maxTotalLamports,'203010000');assert.equal(value.quoteId,'c'.repeat(64));counts.sign++;state={...state,approvedQuote:state.quote,quote:null,canSign:false,canQuote:false,canSend:true,unknown:true};emit();},
 send:async value=>{assert.equal(value.authorizeSend,true);counts.send++;state={...state,canSend:false,canRecover:true};emit();},recover:async value=>{assert.equal(value.authorizeOutcomeCheck,true);counts.recover++;state={...state,approvedQuote:null,verified:1,unknown:false,canRecover:false,canPrepare:true};emit();},recoverWalletResponse:async value=>{assert.equal(value.authorizeResponseRecovery,true);counts.saveResponse++;state={...state,canRecoverWalletResponse:false,canSend:true,approvedQuote:{quoteId:'d'.repeat(64),budget:{unitPriceLamports:'200000000',networkFeeLamports:'10000',assetRentLamports:'1500000',protocolChargeLamports:'1500000',totalLamports:'203010000',projectedOrderTotalLamports:'10150500000'}}};emit();},dispose:()=>{}};
const loaded=await load(),document=dom();let lang='ru';const mounted=loaded.mount({config:loaded.config,document,language:()=>lang,registry:{get:()=>[wallet],on:()=>()=>{}},factory:(_config,{onChange})=>{change=onChange;return client;}});
const dialog=document.querySelector('dialog'),action=name=>dialog.querySelector(`[data-action="${name}"]`),input=name=>dialog.querySelector(`[data-input="${name}"]`),cases=[];
const card=document.getElementById('mintBtn'),primary=action('mint'),msg=()=>dialog.querySelector('[data-view="message"]').textContent,cost=()=>dialog.querySelector('[data-view="quote"]').textContent;
const ok=name=>cases.push({name,passed:true});
try{
 assert.equal(counts.ready,0);assert.equal(loaded.fetches(),0);assert.equal(card.textContent,'МИНТ');assert.deepEqual(dialog.all().filter(n=>n.tagName==='button').map(n=>n.dataset.action),['close','mint']);ok('only-one-purchase-action-in-DOM-no-automatic-wallet-or-order-on-load');
 await card.click();assert.equal(counts.connect,1);assert.equal(counts.persist,1);assert.equal(counts.create,1);assert.equal(counts.prepare,1);assert.equal(counts.quote,1);assert.equal(counts.sign,0);assert.equal(counts.send,0);assert.ok(cost().includes('0.203010000 SOL'));ok('one-click-connects-sole-wallet-and-prepares-an-exact-price-without-payment');
 for(const [locale,label] of [['en','MINT'],['zh','铸造'],['ru','МИНТ']]){lang=locale;mounted.render();assert.equal(card.textContent,label);assert.equal(primary.textContent,label);}ok('stable-label-for-each-language');
 // Change the quote underneath the reviewed price. The next click can only refresh it.
 state.quote={...state.quote,quoteId:'new'};emit();await primary.click();assert.equal(counts.quote,2);assert.equal(counts.sign,0);ok('changed-quote-never-signs-from-the-stale-review');
 await Promise.all([primary.click(),primary.click()]);assert.equal(counts.sign,1);assert.equal(counts.send,1);assert.equal(counts.recover,1);assert.equal(state.verified,1);assert.equal(counts.prepare,1);ok('double-click-signs-and-submits-once-and-does-not-start-the-next-NFT');
 const original=client.quoteCost;client.quoteCost=async()=>{throw Object.assign(Error('CHECK_HTTP'),{status:409});};await primary.click();assert.match(msg(),/На этом шаге оплата не отправляется/);assert.equal(counts.sign,1);client.quoteCost=original;await primary.click();assert.equal(counts.create,1);assert.ok(cost().includes('0.203010000 SOL'));ok('quote-refusal-can-retry-the-same-order-without-charge');
 // A lost wallet reply must not be presented as a connection error, nor trigger payment again.
 const signer=client.sign;client.sign=async()=>{state={...state,canSign:false,canQuote:false,quote:null,paymentUncertain:true,unknown:true};emit();throw Error('WALLET_RESPONSE_UNKNOWN');};
 await primary.click();assert.match(msg(),/Проверяем заказ/);assert.ok(primary.hidden);assert.equal(counts.send,1);client.sign=signer;
 ok('lost-wallet-response-displays-reconciliation-and-never-prompts-a-second-payment');
 await action('close').click();state={...state,salesOpen:false,saleStatus:'closed',quantity:1,verified:0,quote:null,approvedQuote:null,canQuote:false,canSign:false,canSend:false,canPrepare:false,paymentUncertain:true,unknown:true,canRecover:true,saved:[{id:state.scope.id,buyer}]};emit();
 const res=client.refreshReadiness;client.refreshReadiness=async()=>{};const savedRecover=client.recover;client.recover=async()=>{counts.recover++;};const prior=counts.recover;await card.click();assert.equal(counts.recover,prior+1);assert.equal(counts.create,1);assert.equal(counts.sign,1);assert.equal(counts.send,1);assert.ok(primary.hidden);assert.match(msg(),/Результат оплаты пока неизвестен/);ok('closed-sale-reconciles-a-pending-payment-without-signing-or-rebroadcasting');
 client.recover=savedRecover;client.refreshReadiness=res;
 state={...state,verified:1,quantity:1,paymentUncertain:false,unknown:false,canRecover:false};emit();assert.ok(primary.hidden);assert.ok(msg().includes('подтверждена'));ok('completed-order-has-no-extra-action');
 state={...state,scope:null,quantity:null,saved:[],saleStatus:'sold-out',salesOpen:false};emit();assert.ok(card.disabled);state={...state,salesOpen:true,saleStatus:'open',storageAvailable:false};emit();assert.ok(card.disabled);assert.match(msg(),/Хранилище/);ok('sold-out-and-unavailable-storage-block-purchase');assert.equal(loaded.fetches(),0);
 // A saved unsigned order can still offer a quote after its Solana blockhash has expired.
 const events=[],oldQ=client.quoteCost;let reject=true,verifiedExpiry=false;
 const stale=()=>{state={...state,storageAvailable:true,salesOpen:true,saleStatus:'open',scope:{id:'saved-before-phantom',buyer},quantity:1,verified:0,selectedAccount:buyer,currentItemIndex:0,items:[{index:0,state:'wallet-pending',attempt:1}],unknown:true,paymentUncertain:false,canSign:false,canSend:false,canQuote:true,canReviewExpiry:true,canPrepare:false,canRecover:true,canRecoverWalletResponse:false,canReplace:false,canPrepareReplacement:false,quote:null,approvedQuote:null};emit();};
 client.quoteCost=async()=>{events.push('quote');if(reject)throw Object.assign(Error('CHECK_HTTP'),{reason:'SIMULATION_FAILED',status:409});await oldQ();};
 client.reviewExpiry=async a=>{events.push('expiry');assert.equal(a.authorizeExpiryReview,true);if(!verifiedExpiry)return {status:'unknown'};state={...state,items:[{index:0,state:'expired',attempt:1}],unknown:false,canQuote:false,canReviewExpiry:false,canReplace:true};emit();return {status:'expired',outcome:'expired'};};
 client.reviewReplacement=async a=>{events.push('review');assert.equal(a.authorizeReplacement,true);state.canPrepareReplacement=true;emit();};
 client.prepareReviewedReplacement=async a=>{events.push('replace');assert.equal(a.authorizeReplacementSigning,true);reject=false;state={...state,items:[{index:0,state:'wallet-pending',attempt:2}],canQuote:true,canReplace:false,canPrepareReplacement:false};emit();};
 if(dialog.open)await action('close').click();document.getElementById('qty').value='1';stale();await card.click();assert.deepEqual(events,['quote','expiry']);assert.equal(counts.sign,1);assert.equal(counts.send,1);ok('unsigned-409-does-not-replace-an-unproven-expiration');
 const reviewAfterWait=client.reviewExpiry;let busyOnce=true;client.reviewExpiry=async opts=>{if(busyOnce){busyOnce=false;events.push('cooldown');throw Object.assign(Error('UNSIGNED_REVIEW_COOLDOWN'),{code:'UNSIGNED_REVIEW_COOLDOWN',status:429,retryAfter:1});}return await reviewAfterWait(opts);};
 events.length=0;verifiedExpiry=true;await primary.click();assert.deepEqual(events,['quote','cooldown','expiry','review','replace','quote']);assert.ok(cost().includes('0.203010000 SOL'));assert.equal(counts.sign,1);assert.equal(counts.send,1);ok('expired-unsigned-order-reuses-the-same-order-and-presents-a-new-total-before-signature');
 stale();events.length=0;reject=true;client.quoteCost=async()=>{throw Object.assign(Error('CHECK_HTTP'),{reason:'INSUFFICIENT_BALANCE',status:409});};await primary.click();assert.deepEqual(events,[]);assert.match(msg(),/недостаточно/);ok('balance-refusal-never-initiates-replacement');
 stale();events.length=0;let firstRead=true;client.quoteCost=async()=>{events.push('read');if(firstRead){firstRead=false;throw Object.assign(Error('CHECK_HTTP'),{reason:'QUOTE_FRESHNESS_RPC',status:409});}await oldQ();state={...state,canSign:false,salesOpen:false,readiness:{expiredOpen:true},recheckActions:{canSign:true}};emit();};
 await primary.click();assert.deepEqual(events,['read','read']);assert.ok(cost().includes('0.203010000 SOL'));assert.equal(counts.sign,1);assert.equal(counts.send,1);
 ok('expired-status-during-slow-unsigned-quote-still-displays-valid-total-and-never-signs');
 client.quoteCost=oldQ;
 // The status proof can age out while the native preparer is in flight; cost has its own live gate.
 if(dialog.open)await action('close').click();
 stale();state={...state,canQuote:false,canPrepare:true,canReviewExpiry:false,canRecover:false,unknown:false,items:[{index:0,state:'not-started',attempt:0}],readiness:null,recheckActions:{}};
 document.getElementById('qty').value='2';
 const savedPrepare=client.prepare,savedCreate=client.create;
 state.canLeaveDraft=true;state.canChooseQuantity=true;
 client.startNew=async opts=>{assert.equal(opts.nextQuantity,2);state={...state,scope:null,quantity:null,canChooseQuantity:false,canLeaveDraft:false};emit();};
 client.create=async opts=>{assert.deepEqual([opts.quantity,opts.newPurchase],[2,true]);state={...state,scope:{id:'selected-two',buyer},quantity:2,canPrepare:true};emit();};
 client.prepare=async()=>{state={...state,salesOpen:false,saleStatus:'unavailable',canPrepare:false,canQuote:false,readiness:{expiredOpen:true},recheckActions:{canQuote:true},items:[{index:0,state:'wallet-pending',attempt:1}]};emit();};
 client.quoteCost=async()=>{await oldQ();state={...state,salesOpen:true,saleStatus:'open',canSign:true};emit();};
 const qBefore=counts.quote,sBefore=counts.sign;
 await card.click();assert.equal(counts.quote,qBefore+1,'prepare outlived readiness but quote was never requested');assert.match(cost(),/0.203010000 SOL/);
 assert.equal(String(document.getElementById('qty').value),'2');assert.equal(state.quantity,2);client.create=savedCreate;assert.equal(counts.sign,sBefore);
 ok('newly-selected-quantity-and-total-survive-old-draft-and-slow-preparation');
 // Losing proof for an unverified order must never advance to signing or silently do nothing.
 await action('close').click();state={...state,scope:null,saved:[],quantity:null,selectedAccount:buyer,canPrepare:false,canQuote:false,canSign:false,salesOpen:false,saleStatus:'unavailable',readiness:{},recheckActions:{},quote:null};emit();
 client.refreshReadiness=async()=>{};await card.click();assert.equal(dialog.open,false);assert.match(document.getElementById('minted').textContent,/СТАТУС НЕДОСТУПЕН/);assert.equal(counts.sign,sBefore);ok('unverified-fresh-sale-shows-inline-result-and-does-not-create-or-sign');client.prepare=savedPrepare;
 state={...state,salesOpen:true,saleStatus:'open',readiness:{status:'open'},storageAvailable:true};emit();
 assert.equal(document.getElementById('minted').textContent,'','old failed check must not survive new verified open state');
 ok('fresh-confirmation-clears-obsolete-status-unavailable');
 // A real gateway can refuse an unsigned quote for one second after preparation.
 if(dialog.open)await action('close').click();document.getElementById('qty').value='1';stale();const beforePaid=[counts.sign,counts.send];let busyChecks=0;
 client.quoteCost=async()=>{busyChecks++;if(busyChecks===1)throw Object.assign(Error('CHECK_HTTP'),{status:429,reason:'COOLDOWN',retryAfter:1});await oldQ();};
 await card.click();assert.equal(busyChecks,2,'retry a refused unsigned quote once the advertised hold ends');assert.match(cost(),/0.203010000 SOL/);assert.deepEqual([counts.sign,counts.send],beforePaid);
 for(const refusal of [{reason:'DAILY_LIMIT',retryAfter:1},{reason:'COOLDOWN',retryAfter:90},{reason:'COOLDOWN'}]){await action('close').click();stale();busyChecks=0;client.quoteCost=async()=>{busyChecks++;throw Object.assign(Error('CHECK_HTTP'),{status:429,...refusal});};await card.click();assert.equal(busyChecks,1);assert.deepEqual([counts.sign,counts.send],beforePaid);}
 ok('only-time-bounded-explicit-unsigned-cooldown-repeats-never-a-daily-limit-or-payment');
 const source=await readFile(new URL('public-mainnet/main.mjs',root)); // Same browser, second expiry with zero receipts: one explicit click starts the selected new order.
 if(dialog.open)await action('close').click();stale();
 state={...state,quantity:1,canQuote:false,canReviewExpiry:false,canRecover:false,canStartNew:true,canRestartExpired:true,
   items:[{index:0,state:'expired',attempt:2}]};emit();
 document.getElementById('qty').value='2';let reopened=0,newQty=0;const priorTerminalPayments=[counts.sign,counts.send];
 client.startNew=async arg=>{assert.equal(arg.authorizeNewOrder,true);reopened++;state={...state,scope:null,quantity:null,items:[],canRestartExpired:false,canStartNew:false,canCreate:true};emit();};
 client.create=async({quantity})=>{newQty=quantity;state={...state,scope:{id:'new-scope',buyer},quantity,canPrepare:true,currentItemIndex:0,items:[{index:0,state:'not-started',attempt:0}]};emit();};
 client.prepare=async()=>{state={...state,canPrepare:false,canQuote:true,items:[{index:0,state:'wallet-pending',attempt:1}]};emit();};client.quoteCost=oldQ;
 await card.click();assert.equal(reopened,1,'exhausted saved order must release checkout');assert.equal(newQty,2);assert.equal(document.getElementById('qty').value,'2');assert.match(cost(),/0.203010000 SOL/);assert.deepEqual([counts.sign,counts.send],priorTerminalPayments);
 ok('fully-expired-empty-order-allows-explicit-new-quantity-without-signing');
 // A slow wallet connection must not let expired readiness select the previous one-item order.
 await action('close').click();await mounted.connect();
 const connectBefore=client.connectWallet,loadBefore=client.load;
 let readinessRenewals=0;
 state={...state,scope:null,quantity:null,selectedAccount:null,accounts:[],saved:[{id:'saved-one',buyer}],salesOpen:true,saleStatus:'open',canRestartExpired:false,canPrepare:false,canQuote:false,canSign:false,canRecover:false,quote:null,approvedQuote:null};
 document.getElementById('qty').value='6';emit();
 client.connectWallet=async wallet=>{await connectBefore(wallet);state={...state,salesOpen:false,saleStatus:'unavailable',readiness:{expiredOpen:true}};emit();};
 client.refreshReadiness=async()=>{readinessRenewals++;state={...state,salesOpen:true,saleStatus:'open',readiness:{expiredOpen:false}};emit();};
 client.load=async()=>assert.fail('a fresh mint must never restore a different quantity after connection');
 await card.click();assert.equal(readinessRenewals,1);assert.equal(newQty,6);assert.equal(state.quantity,6);assert.match(cost(),/0.203010000 SOL/);assert.deepEqual([counts.sign,counts.send],priorTerminalPayments);
 ok('six-selected-after-slow-wallet-connection-does-not-open-old-one-item-order');
 client.connectWallet=connectBefore;client.load=loadBefore;
 // An expired asset-only estimate gets one new template for the same six,
 // while any retained buyer response keeps its existing recovery path.
 let renewals=0,reads=0;state={...state,canRenewUnsigned:true,canQuote:true,canSign:false,quote:null};emit();
 client.startNew=async opts=>{assert.equal(opts.renewUnsigned,true);renewals++;state={...state,scope:null,quantity:null,items:[],canQuote:false,canSign:false,canRenewUnsigned:false};emit();};
 client.quoteCost=async()=>{if(++reads===1)throw Object.assign(Error('CHECK_HTTP'),{reason:'FEE_UNAVAILABLE',status:409});return oldQ();};
 await primary.click();assert.equal(renewals,1);assert.equal(reads,2);assert.equal(newQty,6);assert.match(cost(),/0.203010000 SOL/);assert.deepEqual([counts.sign,counts.send],priorTerminalPayments);
 ok('expired-unsigned-quote-refreshes-once-and-preserves-six-without-a-wallet-prompt');
 state={...state,canSign:false,canQuote:true,canRenewUnsigned:false,quote:null};emit();
 let outageReads=0;
 client.quoteCost=async()=>{if(++outageReads===1)throw Object.assign(Error('CHECK_HTTP'),{status:503,reason:'CHECK_UNAVAILABLE'});return oldQ();};
 await primary.click();assert.equal(outageReads,2);assert.equal(state.quantity,6);assert.match(cost(),/0.203010000 SOL/);
 assert.deepEqual([counts.sign,counts.send],priorTerminalPayments);
 ok('temporary-gateway-503-retries-only-the-unsigned-read-for-the-selected-quantity');
const proof={version:1,passed:true,checksPassed:cases.length,checksFailed:0,cases,counts,source:{bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')},graph:{bytes:graphBytes.length,sha256:createHash('sha256').update(graphBytes).digest('hex')},
  limitations:['Production public view and complete fixed module graph executed in a small Node VM DOM adapter with trusted synthetic controller ports. Native custody, wallet signatures, RPC and actual browser layout are not attested by these view tests.','Readiness/state gates and genuine browser-native offline instruction planning have separate tests; real account verification remains on the public gateway.']};await writeFile(new URL('../build/public-mainnet/public-buyer-view-validation.SAFE.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:cases.length,counts}));
}finally{mounted.dispose();loaded.stop();}
