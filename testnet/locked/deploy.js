import {Address, Cell, contractAddress, loadStateInit} from 'https://esm.sh/@ton/core@0.62.0?bundle';
const $=id=>document.getElementById(id);
let wallet=null, addressState=null, busy=false, d, ui;
const ownerOk=()=>wallet?.account.chain==='-3' && wallet.account.address.toLowerCase()===d.ownerAddressRaw.toLowerCase();
function refresh(){ $('deploy').disabled=busy || !d || !ownerOk() || addressState!=='uninitialized'; }
async function check(){
  addressState=null; refresh();
  try {
    const r=await fetch('https://testnet.toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(d.collectionAddressRaw),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    const j=await r.json();
    if(!r.ok || !j.ok || !['active','uninitialized','frozen'].includes(j.result?.state)) throw Error('Неизвестное состояние адреса');
    addressState=j.result.state;
    $('chain').textContent=addressState==='active'?'Контракт активен. Повторное развёртывание заблокировано.':addressState==='uninitialized'?'Адрес ещё не развёрнут.':'Адрес заморожен. Операция заблокирована.';
  } catch(e){$('chain').textContent='Не удалось проверить адрес. Операция заблокирована; нажми «Проверить состояние».';}
  refresh();
}
async function init(){
  const r=await fetch('deployment.json',{cache:'no-store'});if(!r.ok)throw Error('Пакет недоступен');
  const candidate=await r.json();
  const initCell=Cell.fromBase64(candidate.stateInitBocBase64);
  const state=loadStateInit(initCell.beginParse());
  const actual=contractAddress(0,state);
  const message=candidate.tonConnectDeployMessage;
  if(candidate.network!=='testnet' || candidate.revealAt!==1798761600 || candidate.initialPaused!==true || actual.toRawString()!==candidate.collectionAddressRaw || !Address.parse(message.address).equals(actual) || !Address.parseFriendly(message.address).isTestOnly || message.stateInit!==candidate.stateInitBocBase64 || message.amount!=='200000000' || state.code.hash().toString('hex')!==candidate.collectionCodeHash) throw Error('Пакет не прошёл проверку');
  d=candidate;
  $('address').textContent=d.collectionAddressTestnetNonBounceable;
  $('package').textContent='Адрес и пакет проверены. Запрет раннего раскрытия подтверждён Sandbox-тестами.';
  if(!window.TON_CONNECT_UI)throw Error('Не удалось загрузить подключение кошелька. Обнови страницу.');
  ui=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://coolbears-nfts.com/tonconnect-manifest.json',buttonRootId:'ton-connect'});
  function walletChanged(w){wallet=w;$('wallet').textContent=!w?'Подключи кошелёк владельца в testnet.':ownerOk()?'Владелец подтверждён, сеть testnet.':'Нужен настроенный кошелёк владельца в сети testnet.';refresh();}
  ui.onStatusChange(walletChanged);walletChanged(ui.wallet);
  $('refresh').disabled=false;$('refresh').onclick=check;
  $('deploy').onclick=async()=>{
    if(busy || !ownerOk())return;
    busy=true;refresh();
    try {
      await check();
      if(!ownerOk() || addressState!=='uninitialized')return;
      $('status').textContent='Подтверди отправку 0,2 тестового TON в кошельке.';
      await ui.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-3',from:d.ownerAddressRaw,messages:[d.tonConnectDeployMessage]});
      $('status').textContent='Запрос передан кошельку. Подпись ещё не подтверждает развёртывание. Проверяю блокчейн…';
      await check();
      if(addressState==='active')$('status').textContent='Контракт активен в testnet. Минт остаётся на паузе.';
      else $('status').textContent='Если подтвердил отправку, подожди подтверждения в сети и нажми «Проверить состояние».';
    }catch(e){$('status').textContent='Операция не завершена: '+(e?.message||e);}
    finally{busy=false;refresh();}
  };
  await check();
}
init().catch(e=>{$('status').textContent='Ошибка: '+e.message;$('deploy').disabled=true;});
