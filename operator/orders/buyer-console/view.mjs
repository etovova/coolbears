import {compatibleBuyerWallet} from '../wallet-client.mjs';
import {explainConsoleError} from './controller.mjs';
export function solFromLamports(value){if(value===undefined||value===null)return 'Not yet known';const n=BigInt(value),whole=n/1000000000n,fraction=(n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');}
export function lamportsFromSol(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,9})?$/.test(value))throw Error('INVALID_COST_LIMIT');const [whole,fraction='']=value.split('.');return (BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'))).toString();}
export function mountPrivateBuyerConsole({controller,registry,document=globalThis.document}={}){
  const el=id=>document.getElementById(id),set=(id,value)=>el(id).textContent=value??'',enable=(id,on)=>el(id).disabled=!on;
  let wallets=[],connectedWallet=null,lastQuote=null,lastTerminal=null,lastAccounts='',lastOrders='',lastScope=null,localError=null,disposed=false;
  const option=(select,label,value)=>{const node=document.createElement('option');node.textContent=label;node.value=value;select.append(node);};
  function refreshWallets(){const chosen=wallets[Number(el('wallets').value)],cluster=controller.state().cluster;wallets=registry.get().filter(wallet=>compatibleBuyerWallet(wallet,cluster));
    if(connectedWallet&&!wallets.includes(connectedWallet)){connectedWallet=null;controller.disconnectWallet();}
    el('wallets').replaceChildren();option(el('wallets'),'Choose a compatible wallet','');wallets.forEach((w,i)=>option(el('wallets'),w.name,String(i)));
    const index=wallets.indexOf(chosen);if(index>=0)el('wallets').value=String(index);render();}
  function render(){
    if(disposed)return;let s;try{s=controller.state();}catch{el('workspace').hidden=true;set('configuration','Saved progress could not be read. No purchase action is enabled.');return;}
    const network=s.cluster==='mainnet-beta'?'Mainnet':'Devnet';
    el('workspace').hidden=false;set('configuration',`Private ${network} candidate. Sending remains disabled.`);
    set('network-banner',`Sales are closed · Item price 0.2 SOL · ${network}`);
    set('wallet-network',`Only wallets that support signing a ${network} transaction without sending it appear here.`);
    el('busy').hidden=!s.busy;el('workspace').setAttribute('aria-busy',String(s.busy));
    el('error').hidden=!(s.error||localError);set('error',s.error||localError);set('account',s.selectedAccount?'Selected: '+s.selectedAccount:'No exact account selected.');
    const accountKey=JSON.stringify(s.accounts);if(accountKey!==lastAccounts){lastAccounts=accountKey;el('accounts').replaceChildren();option(el('accounts'),'Choose an exact account','');
      for(const a of s.accounts)option(el('accounts'),a.address,a.address);}
    const orderKey=JSON.stringify(s.saved);if(orderKey!==lastOrders){lastOrders=orderKey;el('orders').replaceChildren();option(el('orders'),'Choose saved progress','');
      for(const row of s.saved)option(el('orders'),row.id+' · '+row.buyer.slice(0,6)+'…',row.id);}
    if(s.scope?.id!==lastScope){lastScope=s.scope?.id;if(s.scope)el('orders').value=s.scope.id;}
    set('order-id',s.scope?'Order '+s.scope.id:'No order selected.');
    set('progress',s.quantity?`${s.verified} of ${s.quantity} items verified${s.paused?' · Paused':''}${s.currentItemIndex===null?' · Complete':` · Next unresolved item ${s.currentItemIndex+1}`}`:'Create an order or open saved progress.');
    const labels={'not-started':'Not started','wallet-pending':'Preparation saved',unknown:'Outcome unknown',verified:'Verified',failed:'Failed',expired:'Expired'};
    el('items').replaceChildren();for(const item of s.items){const li=document.createElement('li');li.textContent=`Item ${item.index+1}: ${labels[item.state]??'Review required'}${item.attempt?' · attempt '+item.attempt:''}`;el('items').append(li);}
    el('custody').hidden=s.custody!=='unavailable';set('custody','A browser key is unavailable. You can review retained outcomes only. This will not restore the key or change the saved order.');
    const quote=s.quote,key=quote?.quoteId??null;if(key!==lastQuote){lastQuote=key;el('cost-consent').checked=false;el('cost-cap').value=quote?solFromLamports(quote.budget.totalLamports):'';}
    const terminal=JSON.stringify([s.scope?.id,s.currentItemIndex,s.failedFeeLamports,s.canReplace]);if(terminal!==lastTerminal){lastTerminal=terminal;el('replacement-consent').checked=false;el('fee-consent').checked=false;}
    const rows=quote?[
      ['Item price',quote.budget.unitPriceLamports],['Network fee',quote.budget.networkFeeLamports],['Asset account funding',quote.budget.assetRentLamports],
      ['Protocol charges',quote.budget.protocolChargeLamports],['Priority fee',quote.budget.priorityFeeLamports],['Next transaction estimate',quote.budget.totalLamports],
      ['Remaining projection (estimate only)',quote.budget.projectedRemainingTotalLamports??quote.budget.projectedOrderTotalLamports]]:[];
    el('costs').replaceChildren();for(const [label,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=solFromLamports(value)+(value!==undefined?' SOL':'');el('costs').append(dt,dd);}
    set('quote-expiry',quote?'Estimate expires at '+new Date(quote.expiresAt).toLocaleTimeString()+'. A fresh check still runs before signing.':'No current cost approval. Request a fresh estimate.');
    const c=s.costSummary;set('cost-summary',c?`Nominal price of verified items (0.2 SOL each): ${solFromLamports(c.verifiedItemPriceLamports)} SOL. Known failed-attempt fees: ${solFromLamports(c.knownFailedFeesLamports)} SOL. Successful transaction fees and the actual full-order total are not yet known.`:'Actual full-order cost is not yet known. A projection is not a total amount already charged.');
    set('outcome',s.result?(s.result.readOnly?'Read-only outcome · ':'')+(s.result.outcome??s.result.status)+(s.result.feeLamports?' · fee '+solFromLamports(s.result.feeLamports)+' SOL':''):'No outcome check has been completed in this view.');
    set('failed-fee',s.failedFeeLamports?'Previously charged fee: '+solFromLamports(s.failedFeeLamports)+' SOL.':'');el('fee-label').hidden=!s.failedFeeLamports;
    set('replacement-review',s.replacement?`Replacement reviewed for item ${s.replacement.itemIndex+1}, attempt ${s.replacement.attempt}. Preparation requires your separate approval below.`:'No replacement has been reviewed in this view.');
    if(!s.replacement)el('replacement-signing-consent').checked=false;
    for(const [button,flag]of Object.entries({create:'canCreate','new-order':'canStartNew',prepare:'canPrepare',quote:'canQuote','native-recovery':'canRecoverNative','wallet-response-recovery':'canRecoverWalletResponse',recover:'canRecover',pause:'canPause',resume:'canResume'}))enable(button,s[flag]);
    enable('persist',!s.busy&&el('storage-consent').checked);enable('connect',!s.busy&&el('wallets').value!==''&&!s.disposed);
    enable('choose-account',!s.busy&&!!el('accounts').value);enable('resume-order',!s.busy&&!!el('orders').value);enable('refresh',!s.busy&&!!s.scope);
    enable('sign',s.canSign&&el('cost-consent').checked);enable('send',s.canSend&&el('send-consent').checked);
    el('send-consent').disabled=!s.sendingEnabled||s.busy;
    enable('expiry',s.canReviewExpiry&&el('expiry-consent').checked);enable('replace',s.canReplace&&el('replacement-consent').checked&&(!s.failedFeeLamports||el('fee-consent').checked));
    enable('replacement-sign',s.canPrepareReplacement&&el('replacement-signing-consent').checked);
    if(s.quantity!==null)el('quantity').value=String(s.quantity);
    el('quantity').disabled=!!s.scope||s.busy;el('cost-cap').disabled=!quote||s.busy;
  }
  function action(id,fn){el(id).addEventListener('click',async()=>{localError=null;try{const pending=fn();render();await pending;}catch(error){localError=explainConsoleError(error);}finally{render();}});}
  action('persist',()=>controller.requestPersistence({authorizePersistence:el('storage-consent').checked}));
  action('connect',async()=>{const selected=wallets[Number(el('wallets').value)];await controller.connectWallet(selected);connectedWallet=selected;});
  action('choose-account',()=>controller.selectAccount(el('accounts').value));
  action('create',()=>controller.create({quantity:Number(el('quantity').value),authorizeCreate:true}));
  action('resume-order',()=>controller.load(el('orders').value));action('refresh',()=>controller.refresh());
  action('new-order',()=>controller.startNew({authorizeNewOrder:true}));
  action('prepare',()=>controller.prepare({authorizePreparation:true}));action('quote',()=>controller.quoteCost());
  action('sign',()=>{const s=controller.state();const approve=el('cost-consent').checked;el('cost-consent').checked=false;
    return controller.sign({authorizeCost:approve,quoteId:s.quote?.quoteId,maxTotalLamports:lamportsFromSol(el('cost-cap').value)});});
  action('send',()=>{const approve=el('send-consent').checked;el('send-consent').checked=false;return controller.send({authorizeSend:approve});});
  action('recover',()=>controller.recover({authorizeOutcomeCheck:true}));action('native-recovery',()=>controller.recoverNative({authorizeRecovery:true}));
  action('wallet-response-recovery',()=>controller.recoverWalletResponse({authorizeResponseRecovery:true}));
  action('pause',()=>controller.setPaused(true,{authorizeChange:true}));action('resume',()=>controller.setPaused(false,{authorizeChange:true}));
  action('expiry',()=>{const approve=el('expiry-consent').checked;el('expiry-consent').checked=false;return controller.reviewExpiry({authorizeExpiryReview:approve});});
  action('replace',()=>{const s=controller.state(),approve=el('replacement-consent').checked;el('replacement-consent').checked=false;
    return controller.reviewReplacement({authorizeReplacement:approve,acknowledgedFeeLamports:s.failedFeeLamports&&el('fee-consent').checked?s.failedFeeLamports:undefined});});
  action('replacement-sign',()=>{const approve=el('replacement-signing-consent').checked;el('replacement-signing-consent').checked=false;return controller.prepareReviewedReplacement({authorizeReplacementSigning:approve});});
  for(const id of ['storage-consent','wallets','accounts','orders','cost-consent','send-consent','expiry-consent','replacement-consent','replacement-signing-consent','fee-consent'])el(id).addEventListener('change',render);
  const offRegister=registry.on('register',refreshWallets),offUnregister=registry.on('unregister',refreshWallets),timer=setInterval(render,1000);refreshWallets();
  return{render,dispose(){disposed=true;clearInterval(timer);offRegister();offUnregister();controller.dispose();}};
}
