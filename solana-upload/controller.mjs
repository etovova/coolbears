import { createWalletUI } from '../wallet-ui.mjs?v=wallet-standard-20260920';
import { uploadClient, browserUploadStore, runUpload, readWithRecovery, isRateLimit } from './sdk.js?v=upload-rpc-3';
const $=id=>document.getElementById(id),store=browserUploadStore();
const CACHE_KEY='devnet-upload-last-confirmed-v1';
let client,current,checking,busy=false,uploading=false,stopRequested=false;
const wallet=createWalletUI({language:()=> 'ru',onChange:address=>{checking?.abort();if(uploading)stopRequested=true;client=null;current=null;$('account').textContent=address||'Кошелёк не подключён.';render();}});
function render(){
 $('connect').disabled=busy;$('connect').textContent=wallet.address?'Отключить кошелёк':'Подключить кошелёк';
 $('refresh').disabled=busy||!wallet.address;
 $('cancel-check').hidden=!checking;
 $('cancel-check').disabled=!checking||checking.signal.aborted;
 const ready=!busy&&current&&!current.state.pending;
 $('collection').disabled=!ready||!!current.state.collection;
 $('machine').disabled=!ready||!current.collection||!!current.state.machine;
 $('step').disabled=!ready||!current.machine;
 $('backup').disabled=busy;
 $('continuous').disabled=busy;
 $('stop').disabled=!uploading||stopRequested;
 $('group-size').disabled=busy||!!client&&!client.groupSupported();
 $('group-info').textContent=client&&!client.groupSupported()?'Кошелёк поддерживает только одиночную подпись. Проверка отправок всё равно выполняется автоматически.':'Один запрос содержит выбранную группу. Количество подтверждений внутри окна зависит от кошелька.';
}
function getClient(){if(!wallet.provider)throw Error('Подключи кошелёк.');return client ||= uploadClient(wallet.provider,store);}
function renderState(result,stale=false){
 const state=result?.state||{};
 $('progress').value=Number.isInteger(result?.loaded)?result.loaded:0;
 const lines=[`Devnet · ${result?.balance??'—'} тестовых SOL`,`Подготовлено ${result?.loaded??0}/10000`,`Коллекция: ${state.collection||'не создана'}`,`Машина: ${state.machine||'не создана'}`];
 if(state.pending)lines.push('Ожидается подтверждение создания.');
 if(stale)lines.push('Последнее подтверждённое состояние; новая проверка не завершена.');
 $('state').textContent=lines.join(String.fromCharCode(10));
}
function restoreCached(){
 if(current||!wallet.address)return;
 try{
  const cached=store.read(CACHE_KEY);
  if(cached?.owner===wallet.address&&cached.state&&Number.isInteger(cached.loaded)){
   current={...cached,stale:true};renderState(current,true);
  }
 }catch{}
}
function saveCached(result){
 try{store.write(CACHE_KEY,{owner:wallet.address,state:result.state,collection:result.collection,machine:result.machine,loaded:result.loaded,balance:result.balance,savedAt:Date.now()});}catch{}
}
async function refresh(){
 restoreCached();
 checking=new AbortController();
 $('status').textContent=current?'Последний подтверждённый счётчик сохранён. Проверяю обновление…':'Проверяю сохранённые записи и транзакции…';
 render();
 try{
  const result=await readWithRecovery(getClient(),{signal:checking.signal,onProgress:r=>{$('status').textContent=r.status==='cooldown'?`Сервер Devnet RPC ограничил запросы. Повторная проверка через ${r.seconds} с. Можно отменить. Прогресс сохранён.`:`Проверяю состояние · попытка ${r.attempt}/3. Можно отменить проверку.`;}});
  current={...result,stale:false};
  saveCached(result);
  renderState(current,false);
  $('status').textContent='Состояние обновлено.';
 }catch(error){
  if(current){current.stale=true;renderState(current,true);}
  throw error;
 }finally{checking=null;render();}
}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){if(current){current.stale=true;renderState(current,true);}$('status').textContent=e.name==='AbortError'?'Проверка отменена. Последний счётчик сохранён. Можно проверить состояние снова.':isRateLimit(e)?'Devnet RPC всё ещё ограничивает запросы. Проверка остановлена; кнопки доступны. Сохранённые транзакции не потеряны.':e.message;}finally{busy=false;render();}}
$('cancel-check').onclick=()=>{checking?.abort();render();};
$('connect').onclick=()=>run(async()=>{if(wallet.address){await wallet.disconnect();return;}await wallet.connect();await refresh();});
$('refresh').onclick=()=>run(refresh);
for(const kind of ['collection','machine'])$(kind).onclick=()=>run(async()=>{await getClient().create(kind);await refresh();$('status').textContent='Проверь состояние перед следующим действием.';});
function progress(r){
 if(Number.isInteger(r.loaded)){
  $('progress').value=r.loaded;
  if(current){current.loaded=r.loaded;if(['verified','complete'].includes(r.status))current.stale=false;renderState(current,current.stale);}
 }
 const labels={cooldown:`Devnet RPC просит паузу. Проверка продолжится через ${r.seconds} с. Прогресс сохранён.`, 'rate-limited':'Devnet RPC всё ещё ограничивает запросы. Загрузка приостановлена. Попробуй продолжить позже.',checking:'Проверяю сохранённые записи и транзакции…',signing:`Подтверди группу: ${r.count} транзакций, ${r.records} записей.`,sending:`Отправляю группу: ${r.sent}/${r.total}…`,submitted:'Группа отправлена. Проверяю подтверждение автоматически…',pending:`Проверяю ${r.remaining} транзакций. Повторная отправка заблокирована.`,verified:$('continuous').checked?'Группа подтверждена. Готовлю следующую…':'Пакет подтверждён. Можно нажать для следующего.',complete:'Все 10 000 записей проверены.', 'retry-available':'Часть транзакций не выполнена или истекла. Прогресс сохранён. Нажми «Продолжить загрузку» для новой подписи.',waiting:'Подтверждение пока не получено. Нажми «Продолжить загрузку» позже: сначала проверю отправленное.',stopped:'Загрузка остановлена. Прогресс сохранён. Отправленные транзакции будут проверены при продолжении.'};
 if(labels[r.status])$('status').textContent=labels[r.status];
}
$('stop').onclick=()=>{stopRequested=true;$('status').textContent='Останавливаю загрузку после текущего действия…';render();};
$('step').onclick=()=>run(async()=>{
 uploading=true;stopRequested=false;render();
 try{
  const active=getClient();
  const result=await runUpload(active,{size:Number($('group-size').value),continuous:!!$('continuous').checked,stopped:()=>stopRequested,onProgress:progress});
  progress(result);
 }finally{uploading=false;render();}
});
$('backup').onclick=()=>run(async()=>{$('text').hidden=false;$('text').value=getClient().backup();$('text').select();});
render();if(new URL(location.href).searchParams.has('connectWallet'))run(async()=>{await wallet.connect();await refresh();});
