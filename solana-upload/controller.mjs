import { createWalletUI } from '../wallet-ui.mjs?v=wallet-standard-20260920';
import { uploadClient, browserUploadStore, runUpload, isRateLimit } from './sdk.js?v=upload-paced-1';
const $=id=>document.getElementById(id),store=browserUploadStore();
let client,current,busy=false,uploading=false,stopRequested=false;
const wallet=createWalletUI({language:()=> 'ru',onChange:address=>{if(uploading)stopRequested=true;client=null;current=null;$('account').textContent=address||'Кошелёк не подключён.';render();}});
function render(){
 $('connect').disabled=busy;$('connect').textContent=wallet.address?'Отключить кошелёк':'Подключить кошелёк';
 $('refresh').disabled=busy||!wallet.address;
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
async function refresh(){current=null;const result=await getClient().read();current=result;$('progress').value=result.loaded;$('state').textContent=`Devnet · ${result.balance} тестовых SOL\nПодготовлено ${result.loaded}/10000\nКоллекция: ${result.state.collection||'не создана'}\nМашина: ${result.state.machine||'не создана'}${result.state.pending?'\nОжидается подтверждение создания.':''}`;$('status').textContent='Состояние обновлено.';}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){current=null;$('status').textContent=isRateLimit(e)?'Сервер Solana ограничил запросы. Подожди минуту и нажми «Проверить состояние». Сохранённые транзакции не потеряны.':e.message;}finally{busy=false;render();}}
$('connect').onclick=()=>run(async()=>{if(wallet.address){await wallet.disconnect();return;}await wallet.connect();await refresh();});
$('refresh').onclick=()=>run(refresh);
for(const kind of ['collection','machine'])$(kind).onclick=()=>run(async()=>{await getClient().create(kind);await refresh();$('status').textContent='Проверь состояние перед следующим действием.';});
function progress(r){
 if(Number.isInteger(r.loaded)){
  $('progress').value=r.loaded;
  if(current){current.loaded=r.loaded;$('state').textContent=`Devnet · Подготовлено ${r.loaded}/10000\nКоллекция: ${current.state.collection}\nМашина: ${current.state.machine}`;}
 }
 const labels={cooldown:`Сервер Solana просит паузу. Проверка продолжится через ${r.seconds} с. Прогресс сохранён.`, 'rate-limited':'Сервер Solana всё ещё ограничивает запросы. Загрузка приостановлена. Попробуй продолжить позже.',checking:'Проверяю сохранённые записи и транзакции…',signing:`Подтверди группу: ${r.count} транзакций, ${r.records} записей.`,sending:`Отправляю группу: ${r.sent}/${r.total}…`,submitted:'Группа отправлена. Проверяю подтверждение автоматически…',pending:`Проверяю ${r.remaining} транзакций. Повторная отправка заблокирована.`,verified:$('continuous').checked?'Группа подтверждена. Готовлю следующую…':'Пакет подтверждён. Можно нажать для следующего.',complete:'Все 10 000 записей проверены.', 'retry-available':'Часть транзакций не выполнена или истекла. Прогресс сохранён. Нажми «Продолжить загрузку» для новой подписи.',waiting:'Подтверждение пока не получено. Нажми «Продолжить загрузку» позже: сначала проверю отправленное.',stopped:'Загрузка остановлена. Прогресс сохранён. Отправленные транзакции будут проверены при продолжении.'};
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
