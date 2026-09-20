import { createWalletUI } from '../wallet-ui.mjs?v=wallet-standard-20260920';
import { uploadClient, browserUploadStore, runUpload, isRateLimit } from './sdk.js?v=upload-manual-7';
const $=id=>document.getElementById(id),store=browserUploadStore();
let client,current,busy=false;
const wallet=createWalletUI({language:()=> 'ru',onChange:address=>{client=null;current=null;$('account').textContent=address||'Кошелёк не подключён.';render();}});
function render(){
 $('connect').disabled=busy;$('connect').textContent=wallet.address?'Отключить кошелёк':'Подключить кошелёк';
 $('refresh').disabled=busy||!wallet.address;
 const ready=!busy&&current&&!current.state.pending;
 $('setup-info').textContent=current?.state?.collection&&current?.state?.machine?'Используется подтверждённая коллекция и машина Devnet. Повторное создание отключено.':'Подключи кошелёк и нажми «Проверить состояние».';
 $('step').disabled=!ready||!current.machine;
 $('backup').disabled=busy;
 $('group-info').textContent='Одно нажатие отправляет одну группу до 25 записей. Следующая группа — только по твоему нажатию.';
}
function getClient(){if(!wallet.provider)throw Error('Подключи кошелёк.');return client ||= uploadClient(wallet.provider,store);}
function showState(result){
 current=result;
 $('progress').value=result.loaded;
 $('state').textContent=`Devnet
Подготовлено ${result.loaded}/10000
Коллекция: ${result.state.collection||'не создана'}
Машина: ${result.state.machine||'не создана'}${result.state.pending?'\nОжидается подтверждение создания.':''}`;
}
async function refresh(){const result=await getClient().read();showState(result);$('status').textContent='Состояние обновлено.';}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){$('status').textContent=isRateLimit(e)?'Сервер Solana ограничил запросы. Повтори проверку вручную позже. Сохранённые транзакции не потеряны.':e.message;}finally{busy=false;render();}}
$('connect').onclick=()=>run(async()=>{if(wallet.address){await wallet.disconnect();return;}await wallet.connect();await refresh();});
$('refresh').onclick=()=>run(refresh);
function progress(r){
 if(Number.isInteger(r.loaded)){
  $('progress').value=r.loaded;
  if(current){current.loaded=r.loaded;$('state').textContent=`Devnet
Подготовлено ${r.loaded}/10000
Коллекция: ${current.state.collection}
Машина: ${current.state.machine}`;}
 }
 const labels={
  'rate-limited':'Сервер Solana ограничил запросы. Повтори действие вручную позже; повторная отправка не выполняется.',
  checking:'Проверяю сохранённые записи и транзакции…',
  signing:`Подтверди группу: ${r.count} транзакций, ${r.records} записей.`,
  sending:`Отправляю группу: ${r.sent}/${r.total}…`,
  submitted:'Группа отправлена. Нажми «Продолжить загрузку» позже — повторная отправка заблокирована.',
  pending:'Отправленная группа ещё не подтверждена. Нажми «Продолжить загрузку» позже для повторной проверки.',
  verified:'Пакет подтверждён. Можно нажать для следующего.',
  complete:'Все 10 000 записей проверены.',
  'retry-available':'Предыдущая группа истекла или завершилась ошибкой. Прогресс сохранён; можно запросить новую подпись.',
  ready:'Состояние проверено. Можно продолжить загрузку.'
 };
 if(labels[r.status])$('status').textContent=labels[r.status];
}
$('step').onclick=()=>run(async()=>{
 const result=await runUpload(getClient(),{size:1,onProgress:progress});
 progress(result);
});
$('backup').onclick=()=>run(async()=>{$('text').hidden=false;$('text').value=getClient().backup();$('text').select();});
render();if(new URL(location.href).searchParams.has('connectWallet'))run(async()=>{await wallet.connect();await refresh();});
