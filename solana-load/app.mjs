import {loadClient,browserStore,TARGET,SETTINGS_KEY,rpcUrl,DEFAULT_RPC} from './sdk.js?v=load-v2-20260921';
import {phantomBrowseUrl} from '../wallet-core.mjs';
const $=id=>document.getElementById(id),store=browserStore();
let provider,client,busy=false,generation=0,view={},ticker;
const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
const detectedProvider=()=>window.phantom?.solana?.isPhantom?window.phantom.solana:window.solana?.isPhantom?window.solana:null;
// App navigation carries only the page address, never RPC settings or journal data.
$('wallet-open').href=mobile?phantomBrowseUrl(`${window.location.origin}${window.location.pathname}`):'https://phantom.com/download';
$('wallet-open').textContent=mobile?'Открыть в Phantom':'Установить Phantom';
const connectPrompt=()=>detectedProvider()?'Подключи Phantom, чтобы продолжить.':mobile?'Нажми «Открыть в Phantom», затем подключи кошелёк.':'Установи расширение Phantom и обнови страницу.';
const explorer=address=>`https://explorer.solana.com/address/${address}?cluster=devnet`;
$('machine').href=explorer(TARGET.machine);$('collection').href=explorer(TARGET.collection);
function endpoint(){return store.read(SETTINGS_KEY)?.endpoint||DEFAULT_RPC;}
function rpcLabel(){const custom=endpoint()!==DEFAULT_RPC;$('rpc-current').textContent=custom?'Сохранён RPC твоего проекта.':'Используется общий RPC Devnet.';$('rpc').value=custom?endpoint():'';}
function activity(message,error=false){$('activity').textContent=message;$('activity').dataset.error=String(error);}
function render(next=view){
  view=next;
  const connected=provider?.publicKey?.toString(),owned=connected===TARGET.owner;
  const available=Boolean(detectedProvider());
  $('connect').hidden=!available&&!connected;$('wallet-open').hidden=available||Boolean(connected);
  $('connect').textContent=connected?'Отключить Phantom':'Подключить Phantom';$('connect').disabled=busy;
  $('account').textContent=connected?`${connected.slice(0,8)}…${connected.slice(-8)} · Phantom`:'В Phantom должна быть выбрана сеть Devnet.';$('account').title=connected||'';
  $('check').disabled=busy||!owned;$('save-rpc').disabled=busy||!owned;$('rpc').disabled=busy;
  $('upload').disabled=busy||!owned||!view.progress||view.pending||view.progress.loaded===10000;
  $('upload').textContent=view.progress?.loaded===10000?'Все записи загружены':view.pending?'Ожидается результат':'Загрузить следующие 25';
  $('check').textContent=view.pending?'Проверить результат':'Обновить прогресс';
  $('count').textContent=view.progress?new Intl.NumberFormat('ru-RU').format(view.progress.loaded):'—';$('progress').value=view.progress?.loaded??0;
  $('checked').textContent=view.progress?`Проверено в сети: ${new Date(view.progress.checkedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:'Подключи кошелёк — прогресс загрузится из сети.';
  const a=view.lastAttempt;
  const labels={rejected:a?.message||'Phantom отклонил запрос.','account-verified':a?`Записи ${a.start+1}–${a.start+a.count} подтверждены в сети.`:'',submitted:'Phantom отправил транзакцию. Ожидается подтверждение сети.',wallet:'Ожидается подтверждение в Phantom.',unknown:a?.message||'Результат отправки пока неизвестен. Нажми «Проверить результат».',cancelled:'Подтверждение отменено. Можно начать новую попытку.',failed:'Транзакция завершилась ошибкой в сети. Можно начать новую попытку.'};
  $('attempt').hidden=!a;$('attempt').textContent=a?(labels[a.outcome]||'Результат сохранён.'):'';
  $('transaction').hidden=!a?.signature;if(a?.signature)$('transaction').href=`https://explorer.solana.com/tx/${a.signature}?cluster=devnet`;
  if(view.phase==='wallet'&&!ticker){const started=Date.now();ticker=setInterval(()=>activity(`Ожидается ответ Phantom · ${Math.floor((Date.now()-started)/1000)} с`),1000);}
  if(view.phase!=='wallet'&&ticker){clearInterval(ticker);ticker=null;}
}
function makeClient(url=endpoint(),version=generation){return loadClient(provider,store,{endpoint:url,onChange:v=>{if(version===generation)render(v);}});}
async function run(operation){if(busy)return;busy=true;activity('Проверяю Devnet…');render();try{await operation();}catch(e){activity(e.message,true);if(/RPC|сервер/i.test(e.message))$('settings').open=true;}finally{busy=false;if(ticker){clearInterval(ticker);ticker=null;}render();}}
function changed(){generation++;client=null;view={};render();activity('Кошелёк изменился. Обнови прогресс.');}
$('connect').onclick=()=>run(async()=>{
  if(provider?.publicKey){await provider.disconnect();changed();return;}
  const detected=detectedProvider();
  if(!detected){activity(connectPrompt());return;}
  if(provider!==detected){provider=detected;provider.on?.('accountChanged',changed);provider.on?.('disconnect',changed);}
  await provider.connect();generation++;client=makeClient();render(await client.inspect());activity('Прогресс проверен. Можно продолжать.');
});
$('wallet-open').onclick=event=>{if(detectedProvider()){event.preventDefault();return $('connect').onclick();}};
$('check').onclick=()=>run(async()=>{client??=makeClient();const version=generation;const result=await client.inspect();if(version===generation){render(result);activity(result.pending?'Ожидается результат прежней попытки.':'Прогресс проверен.');}});
$('upload').onclick=()=>run(async()=>{const version=generation;client??=makeClient();const result=await client.upload();if(version===generation){render(result);activity(result.pending?'Отправка повторяться не будет. Используй «Проверить результат».':result.progress?.loaded===10000?'Все 10 000 записей проверены.':'Можно загрузить следующий пакет.');}});
$('save-rpc').onclick=()=>run(async()=>{
  const version=generation,url=rpcUrl($('rpc').value.trim()||DEFAULT_RPC),candidate=makeClient(url);
  $('settings-status').textContent='Проверяю подключение…';const result=await candidate.inspect();
  if(version!==generation)throw Error('Кошелёк изменился. Настройка не сохранена.');
  store.write(SETTINGS_KEY,{endpoint:url});client=candidate;rpcLabel();render(result);$('settings-status').textContent='Подключение проверено и сохранено.';activity('RPC готов.');
});
$('export').onclick=()=>{try{client??=makeClient();$('history').value=client.backup();$('history').hidden=false;$('history').focus();$('history').select();}catch(e){activity(e.message,true);}};
try{rpcLabel();$('export').disabled=false;activity(connectPrompt());}catch{activity('Не удалось прочитать настройки браузера.',true);}
render();
