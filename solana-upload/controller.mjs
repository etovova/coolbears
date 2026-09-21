import { createWalletUI } from '../wallet-ui.mjs?v=wallet-standard-20260920';
import { uploadClient, browserUploadStore, runUpload, isRateLimit } from './sdk.js?v=manual-25-check-20260921';
const $=id=>document.getElementById(id),store=browserUploadStore();
let client,current,busy=false,connectionVersion=0,activeRead;
const wallet=createWalletUI({language:()=> 'ru',onChange:address=>{connectionVersion++;activeRead?.abort();client=null;current=null;$('progress').value=0;$('state').textContent='';$('status').textContent='';$('account').textContent=address||'Кошелёк не подключён.';render();}});
function render(){
 $('connect').disabled=busy;$('connect').textContent=wallet.address?'Отключить кошелёк':'Подключить кошелёк';
 $('refresh').disabled=busy||!wallet.address;
 const ready=!busy&&current&&!current.state.pending;
 $('setup-info').textContent=current?.state?.collection&&current?.state?.machine?'Используется подтверждённая коллекция и машина Devnet. Повторное создание отключено.':wallet.address?'Нажми «Проверить состояние», чтобы получить сохранённые в сети записи.':'Подключи кошелёк и нажми «Проверить состояние».';
 $('step').disabled=!ready||!current.machine||current.loaded===10000;
 $('backup').disabled=busy;
 $('group-info').textContent='Одно нажатие отправляет одну группу до 25 записей. Следующая группа — только по твоему нажатию.';
}
function getClient(){if(!wallet.provider)throw Error('Подключи кошелёк.');return client ||= uploadClient(wallet.provider,store);}
function showRpc(rpc){
 $('rpc-details').hidden=!rpc;
 $('rpc-error').textContent=rpc?`${rpc.method} · ${rpc.outcome}\n${rpc.host}\nПодробности включены в журнал для сохранения.`:'';
}
function showState(result){
 current=result;
 $('progress').value=result.loaded;
 $('state').textContent=`Devnet
Подготовлено ${result.loaded}/10000
Коллекция: ${result.state.collection||'не создана'}
Машина: ${result.state.machine||'не создана'}${result.state.pending?'\nОжидается подтверждение создания.':''}`;
}
async function refresh(){
 const version=connectionVersion,abort=new AbortController();activeRead=abort;
 $('status').textContent='Проверяю состояние в Devnet…';
 showRpc();
 try{const result=await getClient().read({signal:abort.signal});if(version===connectionVersion){showState(result);$('status').textContent='Состояние обновлено.';}}
 finally{if(activeRead===abort)activeRead=null;}
}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){if(e.name!=='AbortError'){$('status').textContent=isRateLimit(e)?'Сервер Solana ограничил запросы. Повтори проверку вручную позже. Сохранённые транзакции не потеряны.':e.message;showRpc(e.rpc);}}finally{busy=false;render();}}
$('connect').onclick=()=>run(async()=>{if(wallet.address){await wallet.disconnect();return;}await wallet.connect();await refresh();});
$('refresh').onclick=()=>run(refresh);
function progress(r){
 showRpc(r.rpc);
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
  signing:`Подтверди загрузку ${r.records} записей в кошельке.`,
  sending:'Отправляю подписанный пакет…',
  submitted:'Пакет отправлен. Следующее нажатие кнопки загрузки проверит результат.',
  pending:'Отправленный пакет ещё не подтверждён. Следующее нажатие кнопки загрузки проверит его без повторной отправки.',
  verified:'Пакет подтверждён. Можно нажать для следующего.',
  complete:'Все 10 000 записей проверены.',
  'retry-available':'Предыдущая группа истекла или завершилась ошибкой. Прогресс сохранён; можно запросить новую подпись.',
  ready:'Состояние проверено. Можно продолжить загрузку.'
 };
 if(labels[r.status])$('status').textContent=labels[r.status];
}
$('step').onclick=()=>run(async()=>{
 const version=connectionVersion,update=r=>{if(version===connectionVersion)progress(r);};
 const result=await runUpload(getClient(),{size:1,onProgress:update});
 update(result);
});
$('backup').onclick=()=>run(async()=>{$('text').hidden=false;$('text').value=getClient().backup();$('text').select();});
render();if(new URL(location.href).searchParams.has('connectWallet'))run(async()=>{await wallet.connect();await refresh();});

// Bundle and controller are published together; see verify-static.mjs.
