import {beginCell,Address,Cell,contractAddress,loadStateInit} from 'https://esm.sh/@ton/core@0.62.0?bundle';
const $=id=>document.getElementById(id);
let d,ui,wallet=null,state=null,busy=false,pending=null,checking=null;
const beneficiary=()=>!!d && wallet?.account.chain==='-3' && wallet.account.address.toLowerCase()===d.treasuryAddressRaw.toLowerCase();
const actions=['deploy','claim','unpause','batch','pause'];
const owner=()=>beneficiary() && wallet.account.address.toLowerCase()===d.ownerAddressRaw.toLowerCase();
function allowed(action){
  if(!beneficiary()||!state)return false;
  if(action==='deploy')return state.status==='uninitialized';
  if(state.status!=='active')return false;
  if(action==='claim')return state.minted===0&&state.paused;
  if(action==='unpause')return owner()&&state.minted===1&&state.paused;
  if(action==='batch')return state.minted===1&&!state.paused;
  if(action==='pause')return owner()&&!state.paused;
  return false;
}
function confirmed(action){
  if(state?.status!=='active')return false;
  if(action==='deploy')return true;
  if(action==='claim')return state.minted>0;
  if(action==='unpause')return !state.paused;
  if(action==='batch')return state.minted>=3;
  if(action==='pause')return state.paused;
  return false;
}
function render(){
  for(const action of actions)$(action).disabled=busy||!!pending||!allowed(action);
}
function actionMessage(action){
  if(action==='deploy')return d.tonConnectDeployMessage;
  if(action==='claim')return d.tonConnectCreatorClaimRequest.messages[0];
  const op={unpause:0x554e5053,batch:0x4d494e54,pause:0x50415553}[action];
  if(!op)throw Error('Неизвестная операция');
  const body=beginCell().storeUint(op,32).storeUint(BigInt(Date.now()),64);
  if(action==='batch')body.storeUint(2,8);
  return {address:Address.parse(d.collectionAddressRaw).toString({testOnly:true,bounceable:true}),amount:action==='batch'?'14200000000':'50000000',payload:body.endCell().toBoc().toString('base64')};
}
async function check(){
  if(checking)return checking;
  checking=(async()=>{
    state=null;render();$('refresh').disabled=true;$('refresh').textContent='Проверяю…';
    try{
      const r=await fetch('https://testnet.toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(d.collectionAddressRaw),{cache:'no-store',signal:AbortSignal.timeout(15000)});
      const j=await r.json();if(!r.ok||!j.ok)throw Error('Нет ответа от testnet');
      if(j.result.state==='uninitialized'){state={status:'uninitialized'};$('chain').textContent='Контракт ещё не развёрнут.';}
      else if(j.result.state==='active'){
        if(Cell.fromBase64(j.result.code).hash().toString('hex')!==d.collectionCodeHash)throw Error('Код контракта не совпадает с пакетом');
        const s=Cell.fromBase64(j.result.data).beginParse();
        if(s.loadAddress().toRawString()!==d.ownerAddressRaw)throw Error('Владелец не совпадает');
        const minted=Number(s.loadUintBig(64));s.loadRef();s.loadRef();s.loadRef();
        if(s.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Получатель NFT не совпадает');
        const paused=s.loadBit();state={status:'active',minted,paused};
        $('chain').textContent=`Контракт активен · Выпущено ${minted}/10000 · ${paused?'Публичный минт на паузе':'Публичный минт открыт'}`;
      }else throw Error('Неожиданное состояние адреса');
      if(pending && confirmed(pending)){
        $('status').textContent='Изменение подтверждено состоянием коллекции. Владельцев выпущенных NFT проверим отдельно.';pending=null;
      }
      if(!pending && state.minted>=3 && state.paused)$('status').textContent='Счётчик достиг 3 NFT, публичный минт на паузе. Пакетный выпуск завершён по счётчику; осталось проверить оба NFT.';
    }catch(e){state=null;$('chain').textContent='Проверка не завершена: '+e.message+'. Отправка заблокирована; повтори проверку.';}
    finally{$('refresh').disabled=false;$('refresh').textContent='Проверить состояние';render();}
  })();
  try{await checking;}finally{checking=null;}
}
async function send(action){
  if(busy||pending||!beneficiary())return;
  busy=true;render();
  try{
    await check();if(!allowed(action))throw Error('Операция недоступна для текущего кошелька и состояния');
    const message=actionMessage(action);
    $('status').textContent='Подтверди операцию в своём testnet-кошельке.';
    await ui.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-3',from:d.treasuryAddressRaw,messages:[message]});
    pending=action;$('status').textContent='Запрос передан кошельку. Дождись подтверждения и нажми «Проверить состояние».';
    await check();
  }catch(e){$('status').textContent='Операция не завершена: '+(e?.message||e);}
  finally{busy=false;render();}
}
async function init(){
  const r=await fetch('deployment.json',{cache:'no-store'});if(!r.ok)throw Error('Пакет недоступен');const p=await r.json();
  const init=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());const actual=contractAddress(0,init);
  if(p.network!=='testnet'||p.revealAt!==1798761600||p.initialPaused!==true||actual.toRawString()!==p.collectionAddressRaw||init.code.hash().toString('hex')!==p.collectionCodeHash)throw Error('Неверный пакет');
  const data=init.data.beginParse();if(data.loadAddress().toRawString()!==p.ownerAddressRaw||data.loadUintBig(64)!==0n)throw Error('Неверные начальные данные');
  const content=data.loadRef().beginParse();const cc=content.loadRef().beginParse();if(cc.loadUint(8)!==1||cc.loadStringTail()!==p.collectionMetadataIpfs||content.loadRef().beginParse().loadStringTail()!==p.preRevealMetadataRootIpfs)throw Error('Метаданные не совпадают');
  data.loadRef();data.loadRef();if(data.loadAddress().toRawString()!==p.treasuryAddressRaw||!data.loadBit())throw Error('Неверная конфигурация или пауза');
  const deploy=p.tonConnectDeployMessage,claim=p.tonConnectCreatorClaimRequest;
  for(const m of [deploy,claim.messages[0]])if(!Address.parse(m.address).equals(actual)||!Address.parseFriendly(m.address).isTestOnly)throw Error('Неверный адрес отправки');
  if(deploy.amount!=='200000000'||deploy.stateInit!==p.stateInitBocBase64||claim.network!=='-3'||claim.from!==p.treasuryAddressRaw||claim.messages.length!==1||claim.messages[0].amount!=='7100000000')throw Error('Неверная транзакция');
  const body=Cell.fromBase64(claim.messages[0].payload).beginParse();if(body.loadUint(32)!==0x52535630||body.loadUintBig(64)!==0n||body.remainingBits!==0||body.remainingRefs!==0)throw Error('Неверная команда получения NFT');
  d=p;$('address').textContent=d.collectionAddressTestnetNonBounceable;
  if(!window.TON_CONNECT_UI)throw Error('Подключение кошелька не загрузилось. Обнови страницу.');
  ui=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://coolbears-nfts.com/tonconnect-manifest.json',buttonRootId:'ton-connect'});
  const changed=w=>{wallet=w;$('wallet').textContent=!w?'Подключи кошелёк владельца в testnet.':beneficiary()?'Закреплённый кошелёк подтверждён, сеть testnet.':'Нужен закреплённый кошелёк в testnet.';render();};ui.onStatusChange(changed);changed(ui.wallet);
  $('refresh').onclick=check;for(const action of actions)$(action).onclick=()=>send(action);await check();
}
init().catch(e=>{$('status').textContent='Ошибка: '+e.message;});
