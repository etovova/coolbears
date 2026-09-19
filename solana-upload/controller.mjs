import { createWalletUI } from '../wallet-ui.mjs?v=wallet-standard-20260920';
import { uploadClient, browserUploadStore } from './sdk.js?v=upload-network-2';
const $=id=>document.getElementById(id),store=browserUploadStore();
let client,current,busy=false;
const wallet=createWalletUI({language:()=> 'ru',onChange:address=>{client=null;current=null;$('account').textContent=address||'Кошелёк не подключён.';render();}});
function render(){
 $('connect').disabled=busy;$('connect').textContent=wallet.address?'Отключить кошелёк':'Подключить кошелёк';
 $('refresh').disabled=busy||!wallet.address;
 const ready=!busy&&current&&!current.state.pending;
 $('collection').disabled=!ready||!!current.state.collection;
 $('machine').disabled=!ready||!current.collection||!!current.state.machine;
 $('step').disabled=!ready||!current.machine;
 $('backup').disabled=busy;
}
function getClient(){if(!wallet.provider)throw Error('Подключи кошелёк.');return client ||= uploadClient(wallet.provider,store);}
async function refresh(){current=null;const result=await getClient().read();current=result;$('progress').value=result.loaded;$('state').textContent=`Devnet · ${result.balance} тестовых SOL\nПодготовлено ${result.loaded}/10000\nКоллекция: ${result.state.collection||'не создана'}\nМашина: ${result.state.machine||'не создана'}${result.state.pending?'\nОжидается подтверждение создания.':''}`;}
async function run(fn){if(busy)return;busy=true;render();try{await fn();}catch(e){current=null;$('status').textContent=e.message;}finally{busy=false;render();}}
$('connect').onclick=()=>run(async()=>{if(wallet.address){await wallet.disconnect();return;}await wallet.connect();await refresh();});
$('refresh').onclick=()=>run(refresh);
for(const kind of ['collection','machine'])$(kind).onclick=()=>run(async()=>{await getClient().create(kind);await refresh();$('status').textContent='Проверь состояние перед следующим действием.';});
$('step').onclick=()=>run(async()=>{const r=await getClient().step();const labels={submitted:'Пакет отправлен. Нажми ещё раз для проверки.',pending:'Результат ещё неизвестен. Повторная отправка заблокирована.',verified:'Пакет подтверждён. Можно продолжать.',complete:'Все 10 000 записей проверены.', 'retry-available':'Предыдущая операция не выполнена. Можно повторить отдельным нажатием.'};$('status').textContent=labels[r.status];await refresh();});
$('backup').onclick=()=>run(async()=>{$('text').hidden=false;$('text').value=getClient().backup();$('text').select();});
render();if(new URL(location.href).searchParams.has('connectWallet'))run(async()=>{await wallet.connect();await refresh();});
