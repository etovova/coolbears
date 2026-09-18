import {verifyPackage,verifyLive,itemAddress,verifyItem,testnetRequest,PACKAGE_SHA256,EXPECTED_OWNER} from '../../launch/package-tools.mjs';
const $=id=>document.getElementById(id),actions=['deploy','claim','open','mint'];
const root=new URL('../../',import.meta.url),pendingKey='coolbears-v3-final-testnet-pending';
let core,p,wallet,ui,state,busy=false,checking=null,pending=null,lastReport=null;
try{pending=JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{}
const owner=()=>{try{return wallet?.account?.chain==='-3'&&core.Address.parse(wallet.account.address).toRawString()===EXPECTED_OWNER;}catch{return false;}};
function permitted(action){try{testnetRequest(core,p,action,wallet,state);return true;}catch{return false;}}
function render(){for(const a of actions)$(a).disabled=busy||!!pending||!permitted(a);$('pending-panel').hidden=!pending;$('report').disabled=!lastReport;}
async function addressInfo(address){
 for(let attempt=0;attempt<3;attempt++){
  const r=await fetch('https://testnet.toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(address),{cache:'no-store',signal:AbortSignal.timeout(18000)});
  if([429,503].includes(r.status)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,1800*(attempt+1)));continue;}
  const j=await r.json();if(!r.ok||j.ok!==true||!['active','uninitialized','nonexist','frozen'].includes(j.result?.state))throw Error('Нет достоверного ответа от TESTNET');return j.result;
 }
 throw Error('TESTNET временно недоступен');
}
async function check(){
 if(checking)return checking;
 checking=(async()=>{state=null;lastReport=null;render();$('refresh').disabled=true;$('chain').textContent='Проверяю TESTNET…';
 try{
  const info=await addressInfo(p.collectionAddressRaw);let creatorVerified=false,buyerVerified=false;
  const nft0=itemAddress(core,p,0),nft1=itemAddress(core,p,1);
  if(['nonexist','uninitialized'].includes(info.state)){
   state={status:'uninitialized',creatorVerified:false};$('chain').textContent='Финальный кандидат ещё не развёрнут в TESTNET.';
  }else{
   const d=verifyLive(core,p,info);const next=Number(d.next);
   if(next>0){await new Promise(r=>setTimeout(r,1400));const ni=await addressInfo(nft0.toRawString());if(ni.state==='active')creatorVerified=verifyItem(core,p,ni,0,EXPECTED_OWNER);}
   if(next>1){await new Promise(r=>setTimeout(r,1400));const ni=await addressInfo(nft1.toRawString());if(ni.state==='active')buyerVerified=verifyItem(core,p,ni,1,EXPECTED_OWNER);}
   state={status:'active',next,paused:d.paused,revealed:d.revealed,creatorVerified,buyerVerified};
   $('chain').textContent=`TESTNET · Контракт активен\nВыпущено ${next}/10000\n${d.paused?'Тестовый минт на паузе':'Тестовый минт открыт'}\n#0000 на твоём кошельке: ${creatorVerified?'подтверждено':'не подтверждено'}\n#0001 на твоём кошельке: ${buyerVerified?'подтверждено':'не подтверждено'}`;
  }
  const settled=state.status==='active'&&pending&&(pending.action==='deploy'||pending.action==='claim'&&creatorVerified||pending.action==='open'&&!state.paused||pending.action==='mint'&&buyerVerified);
  if(settled){pending=null;localStorage.removeItem(pendingKey);$('status').textContent='Ожидаемое состояние подтверждено чтением блокчейна. Историю конкретной транзакции проверь в кошельке.';}
  const snapshotPassed=state.status==='active'&&!state.paused&&creatorVerified&&buyerVerified;
  lastReport={schema:1,type:'TESTNET_STATE_SNAPSHOT_NOT_TRANSACTION_AUDIT',network:'testnet',checkedAt:new Date().toISOString(),packageSha256:PACKAGE_SHA256,collectionAddressRaw:p.collectionAddressRaw,codeHash:p.collectionCodeHash,nftItemCodeHash:p.nftItemCodeHash,finalContentCommitment:p.finalContentCommitment,...state,nft0:nft0.toString({testOnly:true}),nft1:nft1.toString({testOnly:true}),snapshotPassed,transactionHistoryVerified:false,mediaAvailabilityVerified:false,mainnetReady:false};
  $('result').textContent=snapshotPassed?'В TESTNET подтверждены финальный контракт и два NFT на твоём кошельке. Ещё нужны проверка истории платежей и отображения скрытого GIF. Реальные продажи не открыты.':'Тестовый сценарий ещё не завершён. Кнопки открываются по мере проверки этапов.';
 }catch(e){state=null;$('chain').textContent='Проверка остановлена: '+e.message+'. Отправка заблокирована.';}
 finally{$('refresh').disabled=false;render();}})();try{await checking;}finally{checking=null;}
}
async function send(action){
 if(busy||pending)return;busy=true;render();
 try{
  await check();const request=testnetRequest(core,p,action,wallet,state,BigInt(Date.now()));
  const m=request.messages[0],labels={deploy:'создание контракта',claim:'тестовый #0000',open:'открытие тестового минта',mint:'обычный тестовый #0001'};
  if(!confirm(`TESTNET — только тестовые TON.\n${labels[action]}\nОтправка: ${Number(m.amount)/1e9} тестовых TON плюс комиссия.\nПродолжить?`))return;
  pending={action,createdAt:new Date().toISOString(),packageSha256:PACKAGE_SHA256};localStorage.setItem(pendingKey,JSON.stringify(pending));render();
  $('status').textContent='Подтверди TESTNET-запрос в кошельке. Реальные TON не требуются.';
  await ui.sendTransaction(request);$('status').textContent='Кошелёк вернул ответ. Ожидаю состояния сети; это ещё не подтверждение выполнения.';
  await new Promise(r=>setTimeout(r,4000));await check();
 }catch(e){$('status').textContent='Запрос не завершён: '+e.message+'. Не отправляй повторно, пока не проверишь историю кошелька.';}
 finally{busy=false;render();}
}
async function init(){
 core=await import('https://esm.sh/@ton/core@0.63.1?bundle');
 const r=await fetch(new URL('launch/candidate.json',root),{cache:'no-store',signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('Пакет недоступен');
 const raw=await r.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
 if(hash!==PACKAGE_SHA256)throw Error('Контрольная сумма пакета изменилась');p=JSON.parse(new TextDecoder().decode(raw));verifyPackage(core,p);
 $('address').textContent=core.Address.parse(p.collectionAddressRaw).toString({bounceable:false,testOnly:true});
 $('refresh').onclick=check;for(const a of actions)$(a).onclick=()=>send(a);
 $('clear-pending').onclick=async()=>{if(!$('cancel-confirm').checked||busy)return;await check();if(pending&&confirm('Снять блокировку только для проверенного отменённого запроса?')){localStorage.removeItem(pendingKey);pending=null;$('cancel-confirm').checked=false;render();}};
 $('report').onclick=()=>{if(!lastReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='CoolBears_testnet_state.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 await check();
 if(!window.TON_CONNECT_UI)throw Error('TON Connect не загрузился. Чтение состояния доступно, подписание недоступно');
 ui=new window.TON_CONNECT_UI.TonConnectUI({manifestUrl:new URL('tonconnect-manifest.json',root).href,buttonRootId:'ton-connect'});
 const changed=w=>{wallet=w;$('wallet').textContent=!w?'Для чтения состояния кошелёк не требуется. Для теста подключи закреплённый кошелёк в TESTNET.':owner()?'Правильный кошелёк, сеть TESTNET.':'Нужен закреплённый кошелёк в TESTNET. В MAINNET все кнопки отправки заблокированы.';render();};ui.onStatusChange(changed);changed(ui.wallet);
}
init().catch(e=>{$('status').textContent='Запуск теста остановлен: '+e.message;render();});
