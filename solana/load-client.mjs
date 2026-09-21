import {TARGET,GENESIS,KEY,LEGACY_KEY,SETTINGS_KEY,decodeProgress,buildUpload,isHeight,validSignature,browserStore} from './load-model.mjs';
import {readRpc,rpcUrl,DEFAULT_RPC} from './load-rpc.mjs';
export {TARGET,KEY,SETTINGS_KEY,browserStore,DEFAULT_RPC,rpcUrl};

function binding(j) {return j&&Object.entries(TARGET).every(([k,v])=>j[k]===v);}
function validateBatch(p) {
  if(!p||!Number.isInteger(p.start)||!Number.isInteger(p.count)||p.start<0||p.count<1||p.count>25||p.start+p.count>10000)throw Error('Некорректная запись ожидающей загрузки.');
}
function initial() {return {version:3,...TARGET,legacyPending:[],pending:null,history:[],events:[],progress:null,lastAttempt:null};}
function attemptId(p){return p?[p.startedAt,p.start,p.count,p.blockhash,p.lastValidBlockHeight].join(':'):null;}
function unapprovedError(j){
  const p=j?.pending,a=j?.lastAttempt;
  if(!binding(j)||j.legacyPending?.length||p?.phase!=='unknown'||p.signature!==null||a?.signature!==null||a?.outcome!=='unknown'||attemptId(a)!==attemptId(p)||!isHeight(p.lastValidBlockHeight)||!Number.isFinite(Date.parse(p.startedAt))||typeof p.blockhash!=='string')return null;
  if(j.events?.some(e=>e.phase==='wallet-return'&&(!Number.isFinite(Date.parse(e.at))||Date.parse(e.at)>=Date.parse(p.startedAt))))return null;
  if(p.walletError?.code===-32603&&isHeight(p.walletError.elapsedMs))return p.walletError;
  // The first v2 mobile journal kept only events. Bind the completed rejection
  // to this exact request, never to an earlier failure or a returned signature.
  const events=j.events??[],i=events.findLastIndex(e=>e.phase==='wallet-request'),request=events[i];
  if(!request||request.start!==p.start||request.count!==p.count||request.lastValidBlockHeight!==p.lastValidBlockHeight||request.at!==p.startedAt)return null;
  const walletEvents=events.slice(i+1).filter(e=>e.phase==='wallet-return'||e.phase==='wallet-error');
  const error=walletEvents[0];
  if(walletEvents.length!==1||error?.phase!=='wallet-error'||error.code!==-32603||!isHeight(error.elapsedMs)||!Number.isFinite(Date.parse(error.at))||Date.parse(error.at)<Date.parse(request.at))return null;
  return {code:error.code,elapsedMs:error.elapsedMs,source:'legacy-wallet-error-event'};
}
function walletDetail(error,endpoint) {
  // Keep the provider's explanation, but never persist its URL or credentials.
  // Do not stringify arbitrary error/data objects (they may contain secrets).
  const parts=[];
  for(const field of [()=>error?.message,()=>error?.data?.message,()=>error?.cause?.message]){
    try{const value=field();if(typeof value==='string'&&!parts.includes(value))parts.push(value);}catch{}
  }
  let text=parts.join(' / ').slice(0,4000);
  for(const value of new URL(endpoint).searchParams.values()){
    if(value)for(const spelling of new Set([value,encodeURIComponent(value)]))text=text.split(spelling).join('[скрыто]');
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi,'[URL скрыт]')
    .replace(/https?%3a%2f%2f[^\s<>"']+/gi,'[URL скрыт]')
    .replace(/\b(?:bearer\s+|(?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,'[ключ скрыт]')
    .replace(/[a-z0-9_+\/-]{24,}={0,2}/gi,'[скрыто]')
    .replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,600);
}
function walletError(e) {
  if(e?.code===4001)return 'Подтверждение отменено в Phantom. Загрузка не отправлена.';
  if(e?.code===-32002)return 'В Phantom уже открыто другое подтверждение. Заверши его перед новой попыткой.';
  if(e?.code===-32003)return 'Phantom отклонил транзакцию как недействительную. Результат сохранён.';
  if(e?.code===4100)return 'Phantom не разрешил действие для этого аккаунта. Подключи кошелёк заново.';
  if(e?.code===-32000)return 'Phantom отклонил параметры транзакции. Результат сохранён.';
  if(e?.code===-32601)return 'Эта версия Phantom не поддерживает отправку. Обнови приложение Phantom.';
  return `Phantom не подтвердил отправку${Number.isInteger(e?.code)?` (код ${e.code})`:''}. Проверь состояние; новая отправка пока заблокирована.`;
}
export function loadClient(provider,store=browserStore(),{endpoint=DEFAULT_RPC,fetch,timeout,now=Date.now,onChange=()=>{},pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  endpoint=rpcUrl(endpoint);let networkChecked=false,journal=null,lastSlot=0,finalizedSlot=0;
  const notify=()=>onChange(view());
  function owner() {if(provider?.publicKey?.toString()!==TARGET.owner)throw Error('Подключи кошелёк владельца коллекции.');}
  function save(){store.write(KEY,journal);notify();}
  function event(e) {if(!journal)return;journal.events.push({at:new Date(now()).toISOString(),...e});journal.events=journal.events.slice(-60);save();}
  const rpc=readRpc(endpoint,{fetch,timeout,now,onEvent:event});
  function load() {
    journal=store.read(KEY)??initial();
    if(![2,3].includes(journal.version)||!binding(journal)||!Array.isArray(journal.history)||!Array.isArray(journal.events)||!Array.isArray(journal.legacyPending))throw Error('Журнал принадлежит другой коллекции.');
    if(journal.probe&&journal.probe.count!==1)throw Error('Некорректная запись пробной загрузки.');
    if(journal.pending){
      validateBatch(journal.pending);
      if(journal.pending.signature&&!validSignature(journal.pending.signature))throw Error('Некорректная подпись в журнале.');
      if(journal.pending.phase==='wallet'){
        journal.pending.phase='unknown';
        journal.lastAttempt={...journal.pending,outcome:'unknown',message:'Предыдущая попытка прервалась. Проверяю результат в сети.'};save();
      }
      // Preserve validated legacy evidence before bounded RPC events rotate it.
      const evidence=unapprovedError(journal);
      if(evidence&&!journal.pending.walletError){journal.pending.walletError=evidence;journal.lastAttempt.walletError=evidence;save();}
    }
    // Retire already open v2 runtimes: their strict version check prevents them
    // from bypassing the persisted one-record probe after manual recovery.
    if(journal.version===2){journal.version=3;save();}
    lastSlot=Math.max(lastSlot,journal.progress?.slot??0);
  }
  function migrate() {
    const old=store.read(LEGACY_KEY);
    if(old?.retiredTo===KEY&&old.version===2)return;
    if(old){
      if(old.version!==1||!binding(old)||!Array.isArray(old.history))throw Error('Не удалось проверить прежний журнал. Данные сохранены.');
      const pending=[...(old.pending?[old.pending]:[]),...(old.pendingGroup??[])];
      const covered=new Set();
      for(const p of pending){validateBatch(p);if(!validSignature(p.signature)||!isHeight(p.lastValidBlockHeight))throw Error('Повреждён прежний журнал.');for(let i=p.start;i<p.start+p.count;i++){if(covered.has(i))throw Error('Пересекающиеся старые пакеты.');covered.add(i);}}
      // A failed retirement write can be retried safely under the same locks.
      if(!journal.legacyArchive){journal.legacyArchive=old;journal.legacyPending=pending;save();}
    }else save();
    // An already open v1 tab now fails its version check. Its original history
    // and unresolved signatures remain recoverable in legacyArchive above.
    store.write(LEGACY_KEY,{version:2,...TARGET,retiredTo:KEY});
  }
  async function network(){if(!networkChecked){if(await rpc('getGenesisHash')!==GENESIS)throw Error('Подключён RPC другой сети. Нужен Solana Devnet.');networkChecked=true;}owner();}
  async function snapshot(commitment='confirmed',minSlot=commitment==='finalized'?finalizedSlot:lastSlot) {
    const result=await rpc('getAccountInfo',[TARGET.machine,{encoding:'base64',commitment,...(minSlot?{minContextSlot:minSlot}:{})}]);
    owner();const progress=decodeProgress(result,minSlot);
    if(commitment==='finalized')finalizedSlot=progress.slot;
    lastSlot=Math.max(lastSlot,progress.slot);
    if(!journal.progress||progress.slot>=journal.progress.slot)journal.progress={loaded:progress.loaded.size,slot:progress.slot,checkedAt:new Date(now()).toISOString(),commitment};
    save();return progress;
  }
  function present(p,progress){const states=Array.from({length:p.count},(_,i)=>progress.loaded.has(p.start+i));if(states.some(Boolean)&&!states.every(Boolean))throw Error('Пакет присутствует частично. Новая отправка остановлена.');return states.every(Boolean);}
  function finish(p,outcome,slot) {
    const entry={...p,outcome,slot,finishedAt:new Date(now()).toISOString()};journal.history.push(entry);
    if(outcome==='account-verified'&&p.count===1)journal.probe=null;
    journal.lastAttempt=entry;journal.pending=null;save();
  }
  async function reconcileLegacy() {
    if(!journal.legacyPending.length)return;
    const epoch=await rpc('getEpochInfo',[{commitment:'finalized'}]);
    if(!isHeight(epoch?.absoluteSlot)||!isHeight(epoch?.blockHeight))throw Error('Не удалось проверить срок прежних транзакций.');
    const progress=await snapshot('finalized',Math.max(finalizedSlot,epoch.absoluteSlot));
    const missing=journal.legacyPending.filter(p=>!present(p,progress));
    let statuses;
    if(missing.length){statuses=await rpc('getSignatureStatuses',[missing.map(p=>p.signature),{searchTransactionHistory:true}]);if(!isHeight(statuses?.context?.slot)||statuses.context.slot<epoch.absoluteSlot||statuses.value?.length!==missing.length)throw Error('RPC вернул устаревшее подтверждение.');}
    const unresolved=[];
    for(const p of journal.legacyPending){let outcome='account-verified';if(!present(p,progress)){const s=statuses.value[missing.indexOf(p)];outcome=s?.confirmationStatus==='finalized'&&s.err!=null?'failed':s===null&&epoch.blockHeight>p.lastValidBlockHeight?'expired':null;}if(outcome)journal.history.push({...p,outcome,slot:progress.slot,legacy:true});else unresolved.push(p);}
    journal.legacyPending=unresolved;save();
  }
  async function inspectPending(progress) {
    const p=journal.pending;if(!p)return;
    if(present(p,progress)){finish(p,'account-verified',progress.slot);return;}
    // A wallet may refresh the blockhash before sending. Its original deadline
    // cannot prove that a wallet-managed, unknown submission has expired.
    if(!p.signature)return;
    const r=await rpc('getSignatureStatuses',[[p.signature],{searchTransactionHistory:true}]);
    if(!isHeight(r?.context?.slot)||r.context.slot<progress.slot||r.value?.length!==1)throw Error('Не удалось проверить подтверждение транзакции.');
    const status=r.value[0];
    if(status?.confirmationStatus==='finalized'&&status.err!=null){finish(p,'failed',r.context.slot);return;}
    // Null/unknown never clears a wallet-managed attempt. No blind re-signing.
  }
  function view() {const j=journal??store.read(KEY);return {progress:j?.progress??null,pending:!!j?.pending||!!j?.legacyPending?.length,lastAttempt:j?.lastAttempt??null,phase:j?.pending?.phase??null,recoveryId:unapprovedError(j)?attemptId(j.pending):null,nextCount:j?.probe?1:25};}
  async function check() {owner();load();await network();await snapshot();migrate();await reconcileLegacy();if(journal.pending){const p=await snapshot('finalized');await inspectPending(p);}return view();}
  return {
    view,
    inspect:()=>store.lock(check),
    async recoverUnapproved(declaration){return store.lock(async()=>{
      owner();load();
      const eligible=()=>declaration?.notApproved===true&&declaration.attemptId===attemptId(journal.pending)&&unapprovedError(journal);
      if(!eligible())throw Error('Восстановление доступно только для этой попытки без подтверждения в Phantom.');
      await network();migrate();if(!eligible())throw Error('Сначала нужно проверить прежние транзакции.');
      const p=journal.pending,epoch=await rpc('getEpochInfo',[{commitment:'finalized'}]);
      if(!isHeight(epoch?.absoluteSlot)||!isHeight(epoch?.blockHeight))throw Error('Не удалось проверить состояние Devnet.');
      const progress=await snapshot('finalized',Math.max(lastSlot,finalizedSlot,epoch.absoluteSlot));owner();
      if(present(p,progress)){finish(p,'account-verified',progress.slot);return view();}
      if(epoch.blockHeight<=p.lastValidBlockHeight)throw Error('Исходная транзакция ещё действительна. Восстановление пока остановлено.');
      // This is the owner's statement, not proof that a wallet-managed send
      // expired. A hash deadline or absence alone never retires an unknown send.
      const recovery={statement:'owner-reported-no-approval',at:new Date(now()).toISOString(),attemptId:declaration.attemptId,blockHeight:epoch.blockHeight,slot:progress.slot};
      journal.probe={count:1,reason:'owner-reported-unapproved',attemptId:declaration.attemptId};
      finish({...p,recovery},'owner-reported-unapproved',progress.slot);
      return view();
    });},
    async upload(){return store.lock(async()=>{
      owner();load();await network();const progress=await snapshot();migrate();
      if(journal.legacyPending.length||journal.pending){await reconcileLegacy();if(journal.pending){const p=await snapshot('finalized');await inspectPending(p);}return view();}
      if(!progress.next)return view();
      if(provider.isPhantom!==true||typeof provider.signAndSendTransaction!=='function')throw Error('Открой загрузку в Phantom: требуется подтверждение и отправка транзакции кошельком.');
      const latest=await rpc('getLatestBlockhash',[{commitment:'confirmed',minContextSlot:progress.slot}]);
      if(latest?.context?.slot<progress.slot)throw Error('RPC вернул устаревший блок.');
      const batch={...progress.next,count:Math.min(progress.next.count,journal.probe?1:25)};
      const tx=buildUpload(batch,latest);owner();
      // Save intent BEFORE handing control to a wallet capable of broadcasting.
      // Reload, refusal, timeout and lost responses must never trigger a resend.
      journal.pending={...batch,phase:'wallet',startedAt:new Date(now()).toISOString(),blockhash:latest.value.blockhash,lastValidBlockHeight:latest.value.lastValidBlockHeight,signature:null};
      journal.lastAttempt={...journal.pending,outcome:'wallet'};event({phase:'wallet-request',start:batch.start,count:batch.count,lastValidBlockHeight:latest.value.lastValidBlockHeight,transactionBytes:tx.serialize({requireAllSignatures:false,verifySignatures:false}).length});
      const started=now();let answer;
      try {answer=await provider.signAndSendTransaction(tx,{preflightCommitment:'confirmed',minContextSlot:latest.context.slot,skipPreflight:false,maxRetries:0});}
      catch(e){
        const message=walletError(e),detail=walletDetail(e,endpoint);
        journal.pending.walletError={code:Number.isInteger(e?.code)?e.code:null,detail,elapsedMs:now()-started};
        event({phase:'wallet-error',...journal.pending.walletError});
        if(e?.code===4001){finish(journal.pending,'cancelled',lastSlot);}
        else if([4100,-32000,-32002,-32003,-32601].includes(e?.code)){finish({...journal.pending,message},'rejected',lastSlot);}
        else{
          journal.pending.phase='unknown';journal.lastAttempt={...journal.pending,outcome:'unknown',message};save();
          // A provider error does not prove failure to broadcast. Check once,
          // without another wallet call, before asking the owner to intervene.
          try{
            const progress=await snapshot('finalized');await inspectPending(progress);
            if(!journal.pending)return view();
          }catch(checkError){event({phase:'wallet-error-verification',outcome:'unavailable',detail:walletDetail(checkError,endpoint)});}
        }
        throw Error(message);
      }
      if(!validSignature(answer?.signature)){journal.pending.phase='unknown';journal.lastAttempt={...journal.pending,outcome:'unknown',message:'Phantom не вернул номер транзакции. Нужна проверка результата.'};save();return view();}
      journal.pending={...journal.pending,signature:answer.signature,phase:'confirming'};
      journal.lastAttempt={...journal.pending,outcome:'submitted'};event({phase:'wallet-return',signature:answer.signature,elapsedMs:now()-started});
      owner();
      // Bounded read-only confirmation. This never asks for another signature
      // and never sends another transaction or starts the next packet.
      for(let attempt=0;attempt<3;attempt++){
        if(attempt)await pause(1500);owner();
        const p=await snapshot('confirmed');
        if(present(journal.pending,p)){finish(journal.pending,'account-verified',p.slot);break;}
      }
      return view();
    });},
    backup:()=>JSON.stringify(store.read(KEY)??initial(),null,2)
  };
}
