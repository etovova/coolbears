import {getWallets} from '@wallet-standard/app';
import {compatibleBuyerWallet} from '../operator/orders/wallet-client.mjs';
import {createPublicBuyerConsole} from './factory.mjs';
async function walletDeadline(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('WALLET_TIMEOUT'),{code:'WALLET_TIMEOUT'})),15000);})]);}finally{clearTimeout(timer);}}
const words={
  en:{quoteRefused:'Could not confirm the total. This step sends no payment. Your order is saved.',serviceBusy:"The service is busy. Keep this purchase and try again shortly.",lowBalance:"The wallet balance is below the required purchase total.",prepareFailed:"NFT preparation did not finish. Keep this saved purchase. No payment is sent by this step.",open:'MINT IS OPEN',neutral:'PUBLIC MINT',pick:'Select a wallet below to connect.',walletApproval:'Confirm the connection in your wallet.',needWallet:'Connect your wallet to start a purchase.',unknown:'STATUS UNAVAILABLE',closed:'NOT OPEN YET',sold:'SOLD OUT',checking:'CHECKING AVAILABILITY',connect:'Connect wallet',disconnect:'Disconnect wallet',mint:'MINT {n} NFT',connectMint:'CONNECT WALLET TO MINT',title:'Mint CoolBears',close:'Close',wallet:'Choose wallet',noWallet:'Open this website in Phantom or Solflare, or install a compatible Solana wallet.',persist:'Save purchase progress',persistNote:'This browser saves your unfinished purchase. It may clear this data. Keep this profile until the purchase is confirmed.',persistConsent:'I understand and allow saving purchase progress in this browser.',create:'Start purchase',prepare:'Prepare NFT',quote:'Get current total',cost:'Cost of the next NFT',price:'NFT price',fee:'Network fee',rent:'Account creation',protocol:'Protocol charge',total:'Total estimate',projection:'Order estimate',estimateNote:'Each NFT needs a fresh estimate and wallet approval. The order estimate can change. This estimate is not a guaranteed debit cap.',costConsent:'I approve this total estimate for the next NFT and one transaction submission.',sign:'Sign and send',send:'Send saved transaction',check:'Check result',save:'Save existing wallet response',restore:'Restore saved purchase',saved:'Saved purchases',progress:'NFTs received: {done} of {total}',next:'Prepare the next NFT when you are ready.',pending:'The result is not yet known. Check the saved purchase; do not sign it again.',done:'Purchase confirmed.',notReady:'Mint is currently unavailable. Saved purchase results can still be checked.',error:'This action could not finish. Saved progress is retained. Check the result before trying another action.',walletError:'A compatible Mainnet wallet is required. Reconnect the same account to continue.',waiting:'Waiting for the result…',pause:'Pause purchase',resume:'Resume purchase',newOrder:'Start another purchase',nativeRecovery:'Restore saved preparation',reviewExpiry:'Review expired transaction',reviewReplacement:'Review replacement',prepareReplacement:'Prepare reviewed replacement',failedFee:'Known fee of the failed attempt',feeConsent:'I acknowledge the failed fee and request a separate replacement review.',unavailable:'Browser storage is unavailable. Minting is blocked; the website remains available.',ready:'Review the next action below.',order:'Purchase',status:'Status'},
  ru:{quoteRefused:'Не удалось подтвердить сумму. На этом шаге оплата не отправляется. Заказ сохранён.',serviceBusy:"Сервис занят. Сохрани этот заказ и попробуй чуть позже.",lowBalance:"В кошельке недостаточно SOL для полной суммы покупки.",prepareFailed:"Подготовка NFT не завершилась. Заказ сохранён. На этом шаге оплата не отправляется.",open:'МИНТ ОТКРЫТ',neutral:'ПУБЛИЧНЫЙ МИНТ',pick:'Выбери кошелёк ниже для подключения.',walletApproval:'Подтверди подключение в кошельке.',needWallet:'Подключи кошелёк, чтобы начать покупку.',unknown:'СТАТУС НЕДОСТУПЕН',closed:'ЕЩЁ НЕ ОТКРЫТ',sold:'ВСЁ РАСПРОДАНО',checking:'ПРОВЕРКА ДОСТУПНОСТИ',connect:'Подключить кошелёк',disconnect:'Отключить кошелёк',mint:'ЗАМИНТИТЬ {n} NFT',connectMint:'ПОДКЛЮЧИТЬ КОШЕЛЁК',title:'Минт CoolBears',close:'Закрыть',wallet:'Выбери кошелёк',noWallet:'Открой этот сайт в Phantom или Solflare либо установи совместимый кошелёк Solana.',persist:'Сохранить ход покупки',persistNote:'Незавершённая покупка сохраняется в этом профиле браузера. Сохрани этот профиль и устройство до подтверждения результата. Браузер может удалить эти данные.',persistConsent:'Я понимаю это и разрешаю сохранить ход покупки в этом браузере.',create:'Начать покупку',prepare:'Подготовить NFT',quote:'Узнать полную сумму',cost:'Расходы на следующий NFT',price:'Цена NFT',fee:'Комиссия сети',rent:'Создание аккаунта',protocol:'Плата протокола',total:'Полная оценка',projection:'Оценка всей покупки',estimateNote:'Для каждого NFT нужны свежая оценка и подтверждение кошелька. Оценка всей покупки может меняться. Эта оценка не гарантирует предел списания.',costConsent:'Разрешаю указанную полную оценку для следующего NFT и одну отправку транзакции.',sign:'Подписать и отправить',send:'Отправить сохранённую транзакцию',check:'Проверить результат',save:'Сохранить готовый ответ кошелька',restore:'Восстановить покупку',saved:'Сохранённые покупки',progress:'Получено NFT: {done} из {total}',next:'Подготовь следующий NFT, когда будешь готов.',pending:'Результат пока неизвестен. Проверь сохранённую покупку, не подписывая её повторно.',done:'Покупка подтверждена.',notReady:'Минт сейчас недоступен. Результат сохранённой покупки можно проверить.',error:'Действие не завершено. Сохранённый ход покупки оставлен. Проверь результат перед следующей попыткой.',walletError:'Нужен совместимый кошелёк Mainnet. Для продолжения подключи тот же аккаунт.',waiting:'Ожидание результата…',pause:'Приостановить покупку',resume:'Продолжить покупку',newOrder:'Начать ещё одну покупку',nativeRecovery:'Восстановить сохранённую подготовку',reviewExpiry:'Проверить истечение транзакции',reviewReplacement:'Проверить замену',prepareReplacement:'Подготовить проверенную замену',failedFee:'Известная комиссия неудачной попытки',feeConsent:'Подтверждаю эту комиссию и прошу отдельно проверить замену.',unavailable:'Хранилище браузера недоступно. Минт заблокирован; сайт продолжает работать.',ready:'Проверь следующее действие ниже.',order:'Покупка',status:'Статус'},
  zh:{quoteRefused:'暂时无法确认总额。此步骤不会付款，订单已保存。',serviceBusy:"服务繁忙。请保留此订单，稍后重试。",lowBalance:"钱包余额不足以支付本次购买总额。",prepareFailed:"NFT 准备未完成。请保留此订单。此步骤不会发送付款。",open:'铸造已开放',neutral:'公开铸造',pick:'请在下方选择要连接的钱包。',walletApproval:'请在钱包中确认连接。',needWallet:'连接钱包以开始购买。',unknown:'状态暂不可用',closed:'尚未开放',sold:'已售罄',checking:'正在检查',connect:'连接钱包',disconnect:'断开钱包',mint:'铸造 {n} 个 NFT',connectMint:'连接钱包开始铸造',title:'铸造 CoolBears',close:'关闭',wallet:'选择钱包',noWallet:'请在 Phantom 或 Solflare 中打开此网站，或安装兼容的 Solana 钱包。',persist:'保存购买进度',persistNote:'未完成的购买保存在此浏览器配置中。确认结果前请保留此配置和设备。浏览器可能会清理这些数据。',persistConsent:'我理解并允许在此浏览器中保存购买进度。',create:'开始购买',prepare:'准备 NFT',quote:'获取完整金额',cost:'下一个 NFT 的费用',price:'NFT 价格',fee:'网络费用',rent:'账户创建',protocol:'协议费用',total:'总额估算',projection:'订单估算',estimateNote:'每个 NFT 都需要新的估算和钱包确认。订单估算可能改变，且不保证扣款上限。',costConsent:'我同意下一个 NFT 的此总额估算和一次交易提交。',sign:'签名并发送',send:'发送已保存交易',check:'检查结果',save:'保存已有钱包响应',restore:'恢复购买',saved:'已保存购买',progress:'已确认 {done}/{total}',next:'准备好后可准备下一个 NFT。',pending:'结果尚不确定。请检查已保存购买，不要再次签名。',done:'购买已确认。',notReady:'铸造目前不可用，但仍可检查已保存购买的结果。',error:'操作未完成，进度已保留。再次操作前请检查结果。',walletError:'需要兼容的 Mainnet 钱包，请重新连接相同账户。',waiting:'正在等待结果…',pause:'暂停购买',resume:'继续购买',newOrder:'开始另一笔购买',nativeRecovery:'恢复已保存准备',reviewExpiry:'检查交易到期',reviewReplacement:'检查替换',prepareReplacement:'准备已检查替换',failedFee:'失败尝试的已知费用',feeConsent:'我确认此失败费用并请求单独检查替换。',unavailable:'浏览器存储不可用，铸造已阻止，网站仍可浏览。',ready:'请检查下面的下一步。',order:'购买',status:'状态'}
};
export const exactSol=value=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw Error('COST_AMOUNT');const n=BigInt(value);return`${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`;};
export function mountPublicMint({config,language=()=> 'en',onWalletChange=()=>{},document=globalThis.document,registry=getWallets(),factory=createPublicBuyerConsole}={}){
  const $=id=>document.getElementById(id),text=key=>(words[language()]??words.en)[key]??words.en[key];
  if(!document.querySelector('link[data-public-mint-css]')){const link=document.createElement('link');link.rel='stylesheet';link.href=config.origin+'/public-mainnet/style.css';link.dataset.publicMintCss='';document.head.append(link);}
  const dialog=document.createElement('dialog');dialog.className='public-mint-dialog';dialog.setAttribute('translate','no');dialog.setAttribute('aria-labelledby','publicMintTitle');
  dialog.innerHTML='<div class="public-mint-head"><h2 id="publicMintTitle"></h2><button data-action="close" type="button">×</button></div><p data-view="network">Solana Mainnet · 0.2 SOL / NFT</p><p data-view="message" role="status" aria-live="polite"></p><div data-view="wallets"></div><div data-view="purchase"><div data-view="saved"><select aria-label="Saved purchases"></select></div><p data-view="progress"></p><div data-view="quote"></div><button data-action="mint" type="button"></button></div>';
  document.body.append(dialog);
  const view=name=>dialog.querySelector(`[data-view="${name}"]`),button=name=>dialog.querySelector(`[data-action="${name}"]`);
  const notices={en:{cancelled:'Signature cancelled.',pending:'The payment result is unknown. Checking your saved order; no second payment will be sent.'},ru:{cancelled:'Подпись отменена.',pending:'Результат оплаты пока неизвестен. Проверяем заказ. Повторной оплаты не будет.'},zh:{cancelled:'已取消签名。',pending:'付款结果尚未确认。正在检查已保存的订单，不会重复付款。'}};
  const stageText={en:{resumeQty:'Saved order: {n} NFT.',restart:'Previous order expired without a payment. Mint starts a new order.',refreshPrice:'Tap Mint to get the current total.',pricing:'Calculating the total…',refreshing:'Refreshing the unsigned order…',awaitExpiry:'Waiting for Solana to verify the previous preparation. No payment was sent.',exhausted:'This order expired. No further attempt is available for this NFT.'},ru:{resumeQty:'Сохранённый заказ: {n} NFT.',restart:'Предыдущий заказ истёк без оплаты. Нажмите «Минт» для нового заказа.',refreshPrice:'Нажмите «Минт», чтобы получить актуальную сумму.',pricing:'Рассчитываем сумму…',refreshing:'Обновляем неподписанный заказ…',awaitExpiry:'Ждём проверки прежней подготовки в Solana. На этом шаге оплата не отправлялась.',exhausted:'Срок этого заказа истёк. Для этого NFT в заказе больше нет попыток.'},zh:{resumeQty:'已保存订单：{n} 个 NFT。',restart:'上一订单已过期且未付款。点击「铸造」开始新订单。',refreshPrice:'点击「铸造」获取当前总额。',pricing:'正在计算总额…',refreshing:'正在更新未签名的订单…',awaitExpiry:'正在等待 Solana 验证上次准备。此步骤未付款。',exhausted:'订单已过期，当前订单中的此 NFT 已无剩余尝试次数。'}};
  const caption=()=>({en:'MINT',ru:'МИНТ',zh:'铸造'})[language()]??'MINT';
  let client,disposed=false,busy=false,message=null,selectedWallet=null,connectedAddress='',timer,storageUnavailable=false,observer=null,checking=null,failed=false,requested=false,entering=false,walletStep=null;
  let selectedOnEntry=null,quoteTimer,restoredQuantity=false,session=0,review=null,picking=false,phase='',recoveryTimer,recoveryCount=0,priceTimer,priceRetries=0;
  function clearReview(){clearTimeout(quoteTimer);review=null;}
  function dismiss(){session++;clearReview();restoredQuantity=false;picking=false;clearTimeout(recoveryTimer);clearTimeout(priceTimer);}
  dialog.addEventListener('close',dismiss);
  button('close').onclick=()=>dialog.close();
  const emitWallet=address=>{connectedAddress=address??'';onWalletChange(connectedAddress);};
  function snapshot(){try{const state=client?.state()??{};storageUnavailable=state.storageAvailable===false;return state;}catch{storageUnavailable=true;return{busy:false,salesOpen:false,saleStatus:'unavailable',saved:[]};}}
  const completed=s=>!!s.quantity&&s.verified===s.quantity;
  const allowed=(s,k)=>s[k]===true||(s.readiness?.expiredOpen===true&&s.recheckActions?.[k]===true);
  const quoteOf=s=>s.quote??s.approvedQuote;
  function currentReview(s){const q=quoteOf(s);return !!(review&&q&&q.quoteId===review.id&&q.budget.totalLamports===review.total&&s.scope?.id===review.scope&&s.scope?.buyer===connectedAddress&&s.currentItemIndex===review.item&&(!q.expiresAt||q.expiresAt>Date.now()));}
  const savedRows=s=>(s.saved??[]).filter(r=>r.buyer===connectedAddress);
  function render(){
    if(disposed)return;dialog.setAttribute('lang',language());const s=snapshot(),closed=s.saleStatus==='closed',sold=s.saleStatus==='sold-out',pending=!!checking||!!s.readiness?.pending;
    const notice=sold?'sold':closed?'closed':failed&&requested&&!pending&&s.saleStatus==='unavailable'&&!s.readiness?.expiredOpen?'unknown':null;
    const badge=$('minted');if(badge){badge.textContent=notice?text(notice):'';const row=badge.parentElement;if(row?.classList?.contains('mint-topline'))row.style.visibility=notice?'visible':'hidden';}
    const card=$('mintBtn');if(card){
      const disabled=!!(busy||entering||storageUnavailable||((closed||sold)&&!s.scope&&!s.saved?.length)),aria=String(pending||entering),label=caption();
      if(card.disabled!==disabled)card.disabled=disabled;
      if(card.getAttribute('aria-busy')!==aria)card.setAttribute('aria-busy',aria);
      // WebKit can lose the native click when its text target is replaced between down and up.
      if(card.textContent!==label)card.textContent=label;
    }
    if($('walletBtn')){$('walletBtn').textContent=connectedAddress?`${connectedAddress.slice(0,4)}…${connectedAddress.slice(-4)}\n${text('disconnect')}`:text('connect');$('walletBtn').title=connectedAddress;}
    $('publicMintTitle').textContent=text('title');button('close').setAttribute('aria-label',text('close'));if(button('mint').textContent!==caption())button('mint').textContent=caption();
    const key=storageUnavailable?'unavailable':walletStep??(busy?(['quote','prepare','opening'].includes(phase)?'pricing':phase==='expiry'?'refreshing':'waiting'):message??(exhausted(s)?(s.canRestartExpired?'restart':'exhausted'):completed(s)?'done':s.paymentUncertain?'pending':!s.salesOpen&&!s.readiness?.expiredOpen?notice:s.quantity&&!currentReview(s)&&(allowed(s,'canQuote')||s.canPrepareReplacement||s.canReplace)?'refreshPrice':null));
    view('message').textContent=key?((stageText[language()]??stageText.en)[key]??(notices[language()]??notices.en)[key]??text(key)):'';view('message').hidden=!key;
    const progress=view('progress');progress.textContent=s.quantity?text('progress').replace('{done}',String(s.verified??0)).replace('{total}',String(s.quantity)):'';progress.hidden=!s.quantity;if(restoredQuantity&&s.quantity)progress.textContent=(stageText[language()]??stageText.en).resumeQty.replace('{n}',String(s.quantity))+' '+progress.textContent;
    const select=view('saved').querySelector('select');view('saved').hidden=!picking;
    if(picking){select.setAttribute('aria-label',text('saved'));const prev=select.value;select.replaceChildren();for(const [i,row] of savedRows(s).entries()){const o=document.createElement('option');o.value=row.id;o.textContent=text('order')+' '+(i+1)+' · '+row.id.slice(-6);select.append(o);}if([...select.options].some(o=>o.value===prev))select.value=prev;}
    const cost=view('quote');cost.replaceChildren();const ok=currentReview(s);
    if(ok){const q=quoteOf(s),list=document.createElement('dl');for(const [label,k] of [['price','unitPriceLamports'],['fee','networkFeeLamports'],['rent','assetRentLamports'],['protocol','protocolChargeLamports'],['total','totalLamports'],...(s.quantity>1?[['projection','projectedOrderTotalLamports']]:[])]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=text(label);dd.textContent=exactSol(q.budget[k])+' SOL';list.append(dt,dd);}cost.append(list);}
    if(s.canReplace&&s.failedFeeLamports){const n=document.createElement('p');n.textContent=text('failedFee')+': '+exactSol(s.failedFeeLamports)+' SOL. '+text('feeConsent');cost.append(n);}
    button('mint').hidden=!!walletStep||completed(s)||(exhausted(s)&&!s.canRestartExpired)||(!busy&&s.paymentUncertain&&!ok&&!s.canReplace&&!s.canRecoverWalletResponse);
    button('mint').disabled=busy||entering||storageUnavailable||!!s.busy||((closed||sold)&&!s.scope&&!savedRows(s).length);
  }
  async function run(fn){if(busy||disposed)return;busy=true;phase='';message=null;render();try{return await fn();}catch(error){const code=String(error?.reason??error?.code??error?.message??'');
    if(code==='SAVED_ORDER_REVIEW_REQUIRED'){picking=true;message='saved';}
    else if(code==='WALLET_CANCELLED')message=snapshot().paymentUncertain?'pending':'cancelled';
    else if(snapshot().paymentUncertain||/WALLET_RESPONSE_(UNKNOWN|PENDING)/.test(code))message='pending';
    else message=/STORAGE|PERSISTENCE|QuotaExceeded|SecurityError/.test(code)||['QuotaExceededError','SecurityError'].includes(error?.name)?'unavailable':code==='INSUFFICIENT_BALANCE'?'lowBalance':code==='QUOTE_FRESHNESS_RPC'?'serviceBusy':/COOLDOWN|BUSY|DAILY_LIMIT/.test(code)||error?.status===429?'serviceBusy':code==='PUBLIC_SALES_CLOSED'?'closed':code==='PUBLIC_READINESS_UNAVAILABLE'?'unknown':phase==='quote'?'quoteRefused':phase==='prepare'?'prepareFailed':/WALLET|ACCOUNT/.test(code)?'walletError':snapshot().paymentUncertain?'pending':'error';
  }finally{busy=false;render();scheduleRecovery();}}
  function show(){if(!dialog.open)dialog.showModal();render();}
  async function chooseWallet(){
    const wallets=registry.get().filter(wallet=>compatibleBuyerWallet(wallet,'mainnet-beta'));view('wallets').replaceChildren();view('purchase').hidden=true;show();
    const title=document.createElement('h3');title.textContent=text('wallet');view('wallets').append(title);
    if(!wallets.length){walletStep='noWallet';render();const paragraph=document.createElement('p');paragraph.textContent=text('noWallet');view('wallets').append(paragraph);for(const[name,url]of(/Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent??'')?[["Phantom",'https://phantom.app/ul/browse/'+encodeURIComponent(config.origin)+'?ref='+encodeURIComponent(config.origin)],["Solflare",'https://solflare.com/ul/v1/browse/'+encodeURIComponent(config.origin)+'?ref='+encodeURIComponent(config.origin)],["Backpack",'https://backpack.app/ul/v1/browse/'+encodeURIComponent(config.origin)+'?ref='+encodeURIComponent(config.origin)]]:[["Phantom",'https://phantom.com/download'],["Solflare",'https://www.solflare.com/download/'],["Backpack",'https://backpack.app/']])){const a=document.createElement('a');a.href=url;a.textContent=name;a.rel='noopener noreferrer';view('wallets').append(a);}return null;}
    return new Promise(resolve=>{let settled=false;const close=()=>{if(!settled){settled=true;resolve(null);}};dialog.addEventListener('close',close,{once:true});for(const wallet of wallets){const node=document.createElement('button');node.type='button';node.textContent=wallet.name;node.onclick=()=>{if(settled)return;settled=true;dialog.removeEventListener('close',close);view('wallets').replaceChildren();view('purchase').hidden=false;resolve(wallet);};view('wallets').append(node);}});
  }
  async function attach(checkout=false){
    const wallets=registry.get().filter(w=>compatibleBuyerWallet(w,'mainnet-beta'));walletStep='pick';
    try{const wallet=checkout&&wallets.length===1?wallets[0]:await chooseWallet();if(!wallet)return false;
      walletStep='walletApproval';render();selectedWallet=wallet;try{await walletDeadline(client.connectWallet(wallet));}catch(error){if(error?.code==='WALLET_TIMEOUT')await client.disconnectWallet();throw error;}
      const s=snapshot(),a=s.accounts?.find(v=>v.address===s.scope?.buyer)??s.accounts?.[0];if(!a)throw Error('WALLET_ACCOUNT_REQUIRED');await client.selectAccount(a.address);emitWallet(a.address);return true;
    }finally{walletStep=null;}
  }
  async function connect(){return run(async()=>{
    if(connectedAddress){if(selectedWallet?.features?.['standard:disconnect'])await walletDeadline(selectedWallet.features['standard:disconnect'].disconnect());await client.disconnectWallet();selectedWallet=null;emitWallet('');clearReview();return;}
    if(await attach())dialog.close();
  });}
  // One read when the mint card first becomes visible. No polling, wallet prompt, or order.
  function checkStatus(){
    if(checking)return checking;
    observer?.disconnect();observer=null;failed=false;
    checking=Promise.resolve().then(()=>client.refreshReadiness()).then(()=>{failed=snapshot().saleStatus==='unavailable';},()=>{failed=true;}).finally(()=>{checking=null;if(!disposed)render();});
    render();return checking;
  }
  async function checkExisting(){
    let s=snapshot();if(s.canRecoverWalletResponse)await client.recoverWalletResponse({authorizeResponseRecovery:true});
    s=snapshot();if(s.canRecoverNative)await client.recoverNative({authorizeRecovery:true});
    s=snapshot();if(s.canRecover&&!s.canSend&&!s.canSign&&!s.canQuote)await client.recover({authorizeOutcomeCheck:true});
    s=snapshot();if(s.unknown&&s.canReviewExpiry&&!s.canSend&&!s.canQuote&&!s.canSign)await client.reviewExpiry({authorizeExpiryReview:true});
  }
  function scheduleRecovery(){clearTimeout(recoveryTimer);if(disposed||busy||!dialog.open||!snapshot().paymentUncertain||recoveryCount>=4)return;
    const token=session;recoveryTimer=setTimeout(()=>{if(token!==session||disposed||!dialog.open||busy)return;recoveryCount++;void run(checkExisting);},[4500,9000,16000,30000][recoveryCount]);}
  const item=s=>s.items?.find(i=>i.index===s.currentItemIndex);
  function exhausted(s){const v=item(s);return v?.attempt===2&&v.state==='expired'&&!s.canReplace&&!s.canPrepareReplacement;}
  function rememberPhase(label){phase=label;render();}
  function unsignedExpiry(e,s){
    return e?.status===409&&['ATTEMPT_EXPIRED','BLOCKHASH_EXPIRED','BLOCKHASH_TOO_OLD','SIMULATION_FAILED','RPC_AMOUNT','FEE_UNAVAILABLE'].includes(e.reason)
      &&s.canReviewExpiry&&item(s)?.state==='wallet-pending'&&!s.paymentUncertain&&!s.canRecoverWalletResponse&&!s.canSend;
  }
  // A confirmed-bank RPC can briefly lag between simulation and its final read.
  // Retry unsigned pricing once after the gateway's existing 45-second hold.
  async function unsignedRead(live,kind,operation){
    const saved=snapshot(),id=saved.scope?.id,index=saved.currentItemIndex,attempt=item(saved)?.attempt;
    let waited=0;
    for(let retries=0;;retries++){
      try{return await operation();}catch(error){
        const cooldown=error?.status===429&&['COOLDOWN','BUSY'].includes(error.reason)&&Number.isInteger(error.retryAfter)&&error.retryAfter>=1&&error.retryAfter<=45;
        const lag=kind==='quote'&&error?.status===409&&error.reason==='QUOTE_FRESHNESS_RPC';
        const seconds=cooldown?error.retryAfter:lag?45:0;
        if(!live()||!seconds||retries>=3||waited+seconds>45)throw error;
        waited+=seconds;rememberPhase(kind);await new Promise(resolve=>setTimeout(resolve,seconds*1000+200));
        const s=snapshot();if(!live()||!id||s.scope?.id!==id||s.scope.buyer!==s.selectedAccount||s.currentItemIndex!==index||item(s)?.attempt!==attempt||s.paymentUncertain||s.canSend||s.canRecoverWalletResponse||
          (kind==='quote'?item(s)?.state!=='wallet-pending':item(s)?.state!=='not-started'))return;
      }
    }
  }
  const quoteRead=live=>unsignedRead(live,'quote',()=>client.quoteCost());
  async function prepareNewQuote(live){
    const before=snapshot();rememberPhase('quote');
    try{await quoteRead(live);}catch(e){
      const prior=snapshot();if(!live()||!unsignedExpiry(e,prior))throw e;
      const id=prior.scope?.id,index=prior.currentItemIndex,attempt=item(prior).attempt;
      const same=s=>s.scope?.id===id&&s.currentItemIndex===index&&s.selectedAccount===s.scope.buyer;
      rememberPhase('expiry');
      for(let retry=0;;retry++){
        try{await client.reviewExpiry({authorizeExpiryReview:true});break;}
        catch(error){
          if(retry||error?.code!=='UNSIGNED_REVIEW_COOLDOWN'||!Number.isSafeInteger(error.retryAfter)||error.retryAfter<1||error.retryAfter>45)throw error;
          await new Promise(resolve=>setTimeout(resolve,error.retryAfter*1000+200));
          const saved=snapshot();if(!live()||!same(saved)||item(saved)?.attempt!==attempt||item(saved)?.state!=='wallet-pending'||!saved.canReviewExpiry||saved.paymentUncertain||saved.canSend||saved.canRecoverWalletResponse)return;
        }
      }
      if(!live())return;let s=snapshot();if(!same(s)||s.paymentUncertain||s.canRecoverWalletResponse||s.canSend)return;
      if(item(s)?.state!=='expired'||item(s)?.attempt!==attempt){
        message='awaitExpiry';clearTimeout(priceTimer);
        if(priceRetries<3){const round=priceRetries++;priceTimer=setTimeout(()=>{if(live()&&!busy&&same(snapshot())&&!snapshot().paymentUncertain)void run(()=>progress());},[12000,26000,46000][round]);}return;
      }
      if(!s.canReplace||attempt!==1){message=s.canRestartExpired?'restart':'exhausted';if(s.canRestartExpired&&selectedOnEntry)syncQuantity(selectedOnEntry);return;}
      // The native expiry port has recorded finalized proof. A new template is unsigned;
      // the displayed quote and buyer approval must both be obtained again.
      await client.reviewReplacement({authorizeReplacement:true});if(!live())return;
      s=snapshot();if(!same(s)||!s.canPrepareReplacement)return;
      await client.prepareReviewedReplacement({authorizeReplacementSigning:true});if(!live())return;
      s=snapshot();if(!same(s)||item(s)?.attempt!==2||!allowed(s,'canQuote'))return;
      rememberPhase('quote');await quoteRead(live);
    }
    if(!live())return;const s=snapshot();if(s.scope?.id!==before.scope?.id||s.currentItemIndex!==before.currentItemIndex)return;
    clearTimeout(priceTimer);if(allowed(s,'canSign')||allowed(s,'canSend'))present(s);
  }
  function present(s){const q=quoteOf(s);if(!q||!s.scope||s.scope.buyer!==connectedAddress)return;review={id:q.quoteId,total:q.budget.totalLamports,scope:s.scope.id,item:s.currentItemIndex};clearTimeout(quoteTimer);if(Number.isSafeInteger(q.expiresAt)&&q.expiresAt>Date.now())quoteTimer=setTimeout(render,q.expiresAt-Date.now()+1);}
  async function restore(id,buyer){await client.load(id);await client.selectAccount(buyer);emitWallet(snapshot().selectedAccount);}
  function syncQuantity(n){const el=$('qty');if(el&&Number.isInteger(n)&&n>=1&&n<=50&&Number(el.value)!==n){el.value=String(n);el.dispatchEvent?.(new Event('input',{bubbles:true}));}}
  async function progress({approve=false,fresh=false}={}){
    const token=session,buyer=connectedAddress,live=()=>!disposed&&dialog.open&&token===session&&buyer===connectedAddress;
    let s=snapshot();if(!buyer||!live())return;
    if(picking){const id=view('saved').querySelector('select').value;if(!savedRows(s).some(row=>row.id===id))return;await restore(id,buyer);picking=false;if(!live())return;s=snapshot();}
    if((fresh&&completed(s))||((fresh||approve)&&s.canRestartExpired)){
      if(!s.salesOpen){await checkStatus();if(!live()||!snapshot().salesOpen){message='notReady';return;}}
      clearReview();restoredQuantity=false;await client.startNew({authorizeNewOrder:true});if(!live())return;s=snapshot();approve=false;
    }
    if(!s.scope&&!s.salesOpen){const rows=savedRows(s);if(rows.length>1){picking=true;message='saved';return;}if(rows.length===1){await restore(rows[0].id,buyer);s=snapshot();}}
    if(!s.scope){
      if(!s.salesOpen){message='notReady';return;}
      const qty=Number($('qty')?.value??1);await client.requestPersistence({authorizePersistence:true});if(!live())return;
      await client.create({quantity:qty,authorizeCreate:true});s=snapshot();if(s.selectedAccount===buyer&&s.scope?.buyer===buyer)emitWallet(buyer);if(!live())return;
    }
    if(s.scope?.buyer!==buyer){message='walletError';return;}if(completed(s))return;
    const selector=$('qty');if(fresh&&selector&&Number.isSafeInteger(s.quantity)&&s.quantity>=1&&s.quantity<=50&&Number(selector.value)!==s.quantity){
      restoredQuantity=true;selector.value=String(s.quantity);selector.dispatchEvent?.(new Event('input',{bubbles:true}));
    }
    if(s.canResume){await client.setPaused(false,{authorizeChange:true});if(!live())return;s=snapshot();}
    // Only the click on a previously displayed, matching estimate may reach a wallet.
    if(approve&&currentReview(s)&&(allowed(s,'canSign')||allowed(s,'canSend'))&&!s.paymentUncertain){
      const agreed={...review};clearReview();
      if(allowed(s,'canSign')){try{await client.sign({authorizeCost:true,quoteId:agreed.id,maxTotalLamports:agreed.total});}
        catch(e){if(live()&&unsignedExpiry(e,snapshot())){await prepareNewQuote(live);return;}throw e;}if(!live())return;}
      s=snapshot();if(s.scope?.id!==agreed.scope||s.currentItemIndex!==agreed.item||s.approvedQuote?.quoteId!==agreed.id||s.approvedQuote?.budget.totalLamports!==agreed.total||!allowed(s,'canSend'))return;
      await client.send({authorizeSend:true});if(live()&&snapshot().canRecover)await client.recover({authorizeOutcomeCheck:true});return;
    }
    clearReview();
    if(s.paymentUncertain||s.canRecoverWalletResponse||s.canRecoverNative||(!allowed(s,'canPrepare')&&!allowed(s,'canQuote')&&!allowed(s,'canSend')&&!s.canReplace&&s.canRecover)){
      await checkExisting();if(!live())return;const after=snapshot();if(allowed(after,'canSend')&&!after.paymentUncertain)present(after);return;
    }
    if(!s.salesOpen){await checkStatus();if(!live())return;s=snapshot();if(!s.salesOpen){message='notReady';return;}}
    if(s.canReplace){if(!approve&&s.failedFeeLamports){message='ready';return;}if(!s.canPrepareReplacement)await client.reviewReplacement({authorizeReplacement:true,...(s.failedFeeLamports?{acknowledgedFeeLamports:s.failedFeeLamports}:{})});if(!live())return;await client.prepareReviewedReplacement({authorizeReplacementSigning:true});if(!live())return;s=snapshot();}
    if(allowed(s,'canPrepare')){rememberPhase('prepare');await unsignedRead(live,'prepare',()=>client.prepare({authorizePreparation:true}));if(!live())return;s=snapshot();}
    if(allowed(s,'canQuote')){await prepareNewQuote(live);return;}
    if(allowed(s,'canSign')||allowed(s,'canSend')){present(s);return;}
    if(!completed(s)&&!exhausted(s))message=s.paymentUncertain?'pending':s.custody&&s.custody!=='available'?'unavailable':!s.salesOpen?'unknown':'prepareFailed';
  }
  button('mint').onclick=()=>snapshot().scope&&connectedAddress?run(()=>progress({approve:true})):enterPurchase();
  async function enterPurchase(){
    if(entering||busy||disposed||storageUnavailable)return;selectedOnEntry=Number($('qty')?.value??1);requested=true;entering=true;recoveryCount=0;priceRetries=0;clearTimeout(priceTimer);clearReview();message=null;render();
    try{
      if(snapshot().salesOpen!==true)await checkStatus();if(disposed||storageUnavailable)return;
      const s=snapshot();if(!s.salesOpen&&!s.scope&&!s.saved?.length)return;
      await run(async()=>{view('wallets').replaceChildren();view('purchase').hidden=false;show();const token=session;
        if(!connectedAddress&&!(await attach(true)))return;if(!dialog.open||session!==token||disposed)return;
        view('wallets').replaceChildren();view('purchase').hidden=false;rememberPhase('opening');await progress({fresh:true});});
    }finally{entering=false;render();}
  }
  $('mintBtn')?.addEventListener('click',enterPurchase);
  client=factory(config,{onChange:state=>{if(selectedWallet&&state.selectedAccount===null&&connectedAddress)emitWallet('');clearTimeout(timer);if(Number.isSafeInteger(state.readiness?.expiresAt))timer=setTimeout(render,Math.max(0,state.readiness.expiresAt-Date.now())+1);render();}});
  const off=[registry.on('register',render),registry.on('unregister',render)];render();
  const card=$('mintBtn');
  if(card&&typeof globalThis.IntersectionObserver==='function'){
    observer=new globalThis.IntersectionObserver(entries=>{if(!disposed&&observer&&entries.some(e=>e.target===card&&e.isIntersecting)){void checkStatus();}},{threshold:0});
    observer.observe(card);
  }
  return Object.freeze({connect,render,state:snapshot,dispose(){disposed=true;observer?.disconnect();observer=null;clearTimeout(timer);off.forEach(fn=>fn());client.dispose();dialog.remove();clearTimeout(recoveryTimer);clearTimeout(priceTimer);clearTimeout(quoteTimer);}});
}
