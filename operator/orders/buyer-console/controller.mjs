// Private UI coordinator. Injected ports are trusted application dependencies, never UI input.
import {PublicKey} from '@solana/web3.js';
import {compatibleBuyerWallet} from '../wallet-client.mjs';
import {validateConsoleConfig,consoleStorageOptions} from './config.mjs';
const need=(v,c)=>{if(!v)throw Error(c);},copy=v=>structuredClone(v);
const terminal=s=>['verified','failed','expired'].includes(s);
const lamports=v=>{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'INVALID_COST_LIMIT');return BigInt(v);};
export function explainConsoleError(error){
  const code=error?.code??error?.message;
  if(/COST|QUOTE/.test(code))return 'The cost approval is missing, changed or expired. Request a fresh estimate and approve it again.';
  if(/WALLET|ACCOUNT/.test(code))return 'The selected wallet or account changed or is unavailable. Reconnect the exact account; saved progress is retained.';
  if(code==='RETAINED_RESPONSE_PENDING')return 'Save the retained wallet response before switching this view or reconnecting. It can be saved without signing again.';
  if(/ASSET_KEY/.test(code))return 'A browser key is unavailable. Only the retained purchase outcome can be reviewed.';
  if(/STORAGE|PERSIST/.test(code))return 'Browser storage is unavailable or permission was not granted. Keep this browser profile; saved progress has not been cleared.';
  if(/BUSY/.test(code))return 'Another operation is still running. Wait for its result.';
  if(code==='SEND_DISABLED')return 'Sending is disabled in this private candidate. No transaction was sent.';
  if(/EXPLICIT|CONSENT/.test(code))return 'Review and explicitly approve this action before continuing.';
  if(/CHECK|SUBMISSION|RPC|OFFLINE|TIMEOUT/.test(code))return 'The check could not finish. The outcome may still be unknown. Review saved progress before another action.';
  return 'This action is blocked. Saved progress is retained; review the order before continuing.';
}
export function createPrivateBuyerController({config,storage,index,prepare,makePorts,storageManager=globalThis.navigator?.storage,
  crypto=globalThis.crypto,clock=()=>Date.now(),onChange=()=>{},sendingEnabled=false}={}){
  config=validateConsoleConfig(config);need(storage?.readRecoverySnapshot&&index?.list&&index?.save&&typeof prepare==='function'&&typeof makePorts==='function','CONSOLE_CONFIGURATION');
  let scope=null,ports=null,evidence=null,summary=null,quote=null,quoteRevision=null,busy=false,error=null,result=null,reviewedReplacement=null,loaded=false;
  let wallet=null,account=null,accounts=[],off=null,epoch=0,disposed=false;
  const emit=()=>{try{onChange(state());}catch{}};
  const clearQuote=()=>{quote=null;quoteRevision=null;};
  const noPendingMemory=()=>need(!ports?.wallet.state().canRecover,'RETAINED_RESPONSE_PENDING');
  const bind=()=>{noPendingMemory();ports?.wallet.dispose?.();ports=scope?makePorts(copy(scope)):null;};
  const invalidate=()=>{epoch++;account=null;accounts=[];clearQuote();reviewedReplacement=null;ports?.wallet.dispose?.();error='The wallet account changed. Reconnect the exact account to continue.';emit();};
  const walletAccounts=selected=>selected.accounts.filter(a=>a.chains?.includes('solana:devnet')&&a.features?.includes('solana:signTransaction')
    &&new PublicKey(a.publicKey).toBase58()===a.address);
  async function connectPortWallet(){
    const selected=wallet,buyer=account?.address,generation=epoch;need(selected&&buyer===scope?.buyer,'WRONG_WALLET');
    off?.();off=null;
    try{await ports.wallet.connect(selected);need(epoch===generation&&wallet===selected,'WALLET_CHANGED');
      accounts=walletAccounts(selected);account=accounts.find(a=>a.address===buyer);need(account,'WRONG_WALLET');
    }finally{if(epoch===generation&&wallet===selected)off=selected.features['standard:events'].on('change',invalidate);}
  }
  function state(){
    const order=evidence?.order,available=evidence?.custody?.status==='available',selected=!!account&&account.address===scope?.buyer;
    const pendingResponse=ports?.wallet.state().canRecover===true;
    const active=order?.items.find(i=>i.attempts.at(-1)?.state!=='verified'),latest=active?.attempts.at(-1);
    const signed=evidence?.submission,asset=evidence?.assetSigning,unknown=!!latest&&!terminal(latest.state);
    const canPrepare=!!order&&available&&!pendingResponse&&!order.paused&&!!active&&!latest;
    const freshQuote=quote&&quoteRevision===order?.revision&&quote.expiresAt>clock();
    const canQuote=available&&selected&&!order?.paused&&ports?.wallet.state().canRequestSignature===true;
    const canReplace=available&&!pendingResponse&&!order?.paused&&['failed','expired'].includes(latest?.state)&&latest.number===1;
    return{configured:true,busy,disposed,error,result:copy(result),scope:scope?{id:scope.id,buyer:scope.buyer}:null,
      saved:index.list(),accounts:accounts.map(a=>({address:a.address})),selectedAccount:account?.address??null,walletName:wallet?.name??null,
      salesOpen:false,unitPriceSol:'0.2',sendingEnabled:sendingEnabled===true,custody:evidence?.custody?.status??null,
      paused:order?.paused??false,quantity:order?.quantity??null,verified:order?.items.filter(i=>i.attempts.at(-1)?.state==='verified').length??0,
      currentItemIndex:active?.index??null,items:order?.items.map(i=>({index:i.index,state:i.attempts.at(-1)?.state??'not-started',attempt:i.attempts.at(-1)?.number??0}))??[],
      quote:freshQuote?copy(quote):null,costSummary:copy(summary),unknown,
      canCreate:!scope&&!!account&&!busy,canStartNew:!busy&&!pendingResponse&&!!scope&&loaded&&(!order||order.items.every(i=>i.attempts.at(-1)?.state==='verified')),
      canPrepare:!busy&&canPrepare,canQuote:!busy&&!!canQuote,
      canSign:!busy&&!!canQuote&&!!freshQuote,canSend:!busy&&sendingEnabled===true&&available&&!pendingResponse&&selected&&!order?.paused&&signed?.status==='ready'
        &&signed.costApproval?.quote.expiresAt>clock(),canRecover:!busy&&(!pendingResponse||!available)&&!!(signed||evidence?.responseRecovery||evidence?.prewalletRecovery),
      canRecoverNative:!busy&&available&&asset?.status==='asset-signing-unknown',canReviewExpiry:!busy&&available&&!pendingResponse&&unknown,
      canRecoverWalletResponse:!busy&&available&&ports?.wallet.state().canRecover===true,
      canReplace:!busy&&canReplace,failedFeeLamports:latest?.state==='failed'?(signed?.failureRecord?.evidence.feeLamports??evidence?.responseRecovery?.feeLamports??evidence?.prewalletRecovery?.feeLamports):null,
      replacement:reviewedReplacement?{itemIndex:reviewedReplacement.report.candidate.itemIndex,attempt:2,acknowledgedFeeLamports:reviewedReplacement.acknowledgedFeeLamports}:null,
      canPrepareReplacement:!busy&&canReplace&&!!reviewedReplacement,
      canPause:!busy&&available&&!!order&&order.items.some(i=>i.attempts.length)&&!order.paused,canResume:!busy&&available&&!!order&&order.paused,
      readyToSign:false,readyToSubmit:false};
  }
  async function refresh(){
    if(!scope){evidence=null;summary=null;return;}
    const prior=evidence?.order?.revision;evidence=await storage.readRecoverySnapshot(copy(scope));loaded=true;
    if(prior!==evidence?.order?.revision||evidence?.custody.status!=='available'){clearQuote();reviewedReplacement=null;}
    if(evidence?.custody.status==='available'){
      if(typeof storage.readCostSummary==='function')summary=await storage.readCostSummary(copy(scope));
      await ports.wallet.load();
    }else summary=null;
  }
  async function run(fn){need(!busy&&!disposed,'BUSY');busy=true;error=null;emit();try{return await fn();}
    catch(e){error=explainConsoleError(e);throw e;}finally{busy=false;emit();}}
  async function updateAfter(fn){try{return await fn();}finally{await refresh();}}
  const enabled=key=>need(state()[key]||busy&&stateUnlocked()[key],'ACTION_BLOCKED');
  const stateUnlocked=()=>{const was=busy;busy=false;try{return state();}finally{busy=was;}};
  const consent=(v,name)=>need(v===true,'EXPLICIT_'+name+'_REQUIRED');
  const recoveryPort=()=>evidence?.submission?ports.sender:evidence?.responseRecovery?ports.response:ports.prewallet;
  const summarize=value=>({status:value?.status??'unknown',outcome:value?.outcome??(terminal(value?.status)?value.status:undefined),
    readOnly:value?.readOnly===true,feeLamports:value?.feeLamports??value?.evidence?.feeLamports??value?.report?.evidence?.feeLamports});
  return Object.freeze({state,
    async load(id){return run(async()=>{noPendingMemory();const row=index.list().find(v=>v.id===id);need(row,'ORDER_NOT_FOUND');
      scope={id:row.id,buyer:row.buyer,cluster:config.cluster,machine:config.machine,collection:config.collection,guard:config.guard,...consoleStorageOptions(config)};account=null;bind();clearQuote();reviewedReplacement=null;loaded=false;result=null;await refresh();return stateUnlocked();});},
    async startNew({authorizeNewOrder=false}={}){return run(async()=>{consent(authorizeNewOrder,'NEW_ORDER');await refresh();enabled('canStartNew');
      ports?.wallet.dispose?.();scope=null;ports=null;evidence=null;summary=null;loaded=false;clearQuote();reviewedReplacement=null;result=null;return stateUnlocked();});},
    async refresh(){return run(async()=>{await refresh();return stateUnlocked();});},
    async requestPersistence({authorizePersistence=false}={}){return run(async()=>{consent(authorizePersistence,'PERSISTENCE');
      need(typeof storageManager?.persist==='function'&&await storageManager.persist()===true&&await storageManager.persisted()===true,'PERSISTENT_STORAGE_REQUIRED');return true;});},
    async connectWallet(selected){return run(async()=>{noPendingMemory();need(compatibleBuyerWallet(selected),'WALLET_UNSUPPORTED');off?.();ports?.wallet.dispose?.();clearQuote();
      const generation=++epoch;wallet=selected;account=null;accounts=[];off=null;
      await selected.features['standard:connect'].connect();need(epoch===generation,'WALLET_CHANGED');
      accounts=walletAccounts(selected);need(accounts.length>0,'WALLET_ACCOUNT_REQUIRED');
      off=selected.features['standard:events'].on('change',invalidate);return stateUnlocked();});},
    async selectAccount(address){return run(async()=>{noPendingMemory();const chosen=accounts.find(a=>a.address===address);need(chosen&&(!scope||scope.buyer===address),'WRONG_WALLET');
      account=chosen;clearQuote();if(scope){bind();await connectPortWallet();await refresh();}return stateUnlocked();});},
    disconnectWallet(){off?.();off=null;wallet=null;invalidate();},
    async create({quantity,authorizeCreate=false}={}){return run(async()=>{consent(authorizeCreate,'CREATE');need(!scope&&account,'ACCOUNT_REQUIRED');
      need(Number.isSafeInteger(quantity)&&quantity>=1&&quantity<=50,'INVALID_QUANTITY');need(await storageManager?.persisted?.()===true,'PERSISTENT_STORAGE_REQUIRED');
      const generation=epoch,id='buyer-'+[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
      scope={id,buyer:account.address,cluster:config.cluster,machine:config.machine,collection:config.collection,guard:config.guard,...consoleStorageOptions(config)};
      // Save the scope before creation so a lost commit reply is resumable. Never erase an uncertain pointer.
      await index.save(scope);need(epoch===generation&&account?.address===scope.buyer,'WALLET_CHANGED');bind();await updateAfter(()=>storage.create({...scope,quantity,available:quantity}));
      await connectPortWallet();await refresh();return stateUnlocked();});},
    async prepare({authorizePreparation=false}={}){return run(async()=>{consent(authorizePreparation,'PREPARATION');await refresh();enabled('canPrepare');clearQuote();
      return updateAfter(async()=>{const checked=await prepare({order:copy(evidence.order)});return storage.prepareAssetSigning(copy(scope),checked.candidate);});});},
    async quoteCost(){return run(async()=>{await refresh();enabled('canQuote');clearQuote();const generation=epoch;
      const fresh=await ports.wallet.quoteCost();need(epoch===generation,'WALLET_CHANGED');quote=copy(fresh);quoteRevision=evidence.order.revision;return copy(quote);});},
    async sign({authorizeCost=false,quoteId,maxTotalLamports}={}){return run(async()=>{consent(authorizeCost,'COST');await refresh();enabled('canSign');
      need(quote&&quote.quoteId===quoteId&&quote.expiresAt>clock()&&lamports(maxTotalLamports)>=lamports(quote.budget.totalLamports),'COST_APPROVAL_REQUIRED');clearQuote();
      return updateAfter(()=>ports.wallet.signOnly({authorizeCost:true,quoteId,maxTotalLamports}));});},
    async send({authorizeSend=false}={}){return run(async()=>{consent(authorizeSend,'SEND');need(sendingEnabled===true,'SEND_DISABLED');await refresh();enabled('canSend');
      return updateAfter(async()=>{const value=await ports.sender.sendOnce({authorizeDevnetSend:true});result=summarize(value);return copy(result);});});},
    async recover({authorizeOutcomeCheck=false}={}){return run(async()=>{consent(authorizeOutcomeCheck,'OUTCOME_CHECK');await refresh();enabled('canRecover');clearQuote();
      return updateAfter(async()=>{let value;if(evidence.custody.status!=='available')value=await ports.custody.check({authorizeCheck:true});
        else if(evidence.submission)value=await ports.sender.recover();else if(evidence.responseRecovery)value=await ports.response.recoverMissingResponse();else value=await ports.prewallet.recover();
        result=summarize(value);return copy(result);});});},
    async recoverNative({authorizeRecovery=false}={}){return run(async()=>{consent(authorizeRecovery,'NATIVE_RECOVERY');await refresh();enabled('canRecoverNative');
      return updateAfter(()=>storage.recoverAssetSigning(copy(scope)));});},
    async recoverWalletResponse({authorizeResponseRecovery=false}={}){return run(async()=>{consent(authorizeResponseRecovery,'RESPONSE_RECOVERY');await refresh();enabled('canRecoverWalletResponse');
      return updateAfter(async()=>{const value=await ports.wallet.recover();result=summarize(value);return copy(result);});});},
    async reviewExpiry({authorizeExpiryReview=false}={}){return run(async()=>{consent(authorizeExpiryReview,'EXPIRY_REVIEW');await refresh();enabled('canReviewExpiry');clearQuote();
      return updateAfter(async()=>{const value=await recoveryPort().reviewExpiry({authorizeExpiryReview:true});result=summarize(value);return copy(result);});});},
    async reviewReplacement({authorizeReplacement=false,acknowledgedFeeLamports}={}){return run(async()=>{consent(authorizeReplacement,'REPLACEMENT');await refresh();enabled('canReplace');
      const fee=stateUnlocked().failedFeeLamports;need(fee?acknowledgedFeeLamports===fee:acknowledgedFeeLamports===undefined,'COST_ACKNOWLEDGMENT_REQUIRED');clearQuote();
      reviewedReplacement=null;const generation=epoch,baseline=JSON.stringify(evidence),report=await recoveryPort().prepareReplacement({authorizeReplacement:true,acknowledgedFeeLamports});
      await refresh();need(epoch===generation&&JSON.stringify(evidence)===baseline,'STALE_REPLACEMENT_REVIEW');reviewedReplacement={report:copy(report),baseline,acknowledgedFeeLamports};return stateUnlocked().replacement;});},
    async prepareReviewedReplacement({authorizeReplacementSigning=false}={}){return run(async()=>{consent(authorizeReplacementSigning,'REPLACEMENT_SIGNING');await refresh();enabled('canPrepareReplacement');
      const reviewed=reviewedReplacement;need(reviewed&&JSON.stringify(evidence)===reviewed.baseline,'STALE_REPLACEMENT_REVIEW');reviewedReplacement=null;clearQuote();
      return updateAfter(()=>storage.prepareReplacementSigning(copy(scope),reviewed.report,{authorizeReplacementSigning:true,acknowledgedFeeLamports:reviewed.acknowledgedFeeLamports}));});},
    async setPaused(paused,{authorizeChange=false}={}){return run(async()=>{consent(authorizeChange,'PAUSE_CHANGE');await refresh();enabled(paused?'canPause':'canResume');clearQuote();
      return updateAfter(()=>storage.append(copy(scope),{type:paused?'pause':'resume',revision:evidence.order.revision}));});},
    dispose(){disposed=true;epoch++;off?.();ports?.wallet.dispose?.();account=null;accounts=[];clearQuote();emit();},
  });
}
