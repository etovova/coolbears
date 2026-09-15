import {beginCell,Address,Cell,contractAddress,loadStateInit} from 'https://esm.sh/@ton/core@0.62.0?bundle';
const $=id=>document.getElementById(id);
let d,ui,wallet=null,state=null,busy=false,pending=null,checking=null;
const isOwner=()=>!!d&&wallet?.account.chain==='-239'&&wallet.account.address.toLowerCase()===d.ownerAddressRaw.toLowerCase();
const actions=['deploy','claim','unpause'];
function allowed(action){
  if(!isOwner()||!state)return false;
  if(action==='deploy')return state.status==='uninitialized';
  if(state.status!=='active')return false;
  if(action==='claim')return state.minted===0&&state.paused;
  if(action==='unpause')return state.minted===1&&state.paused;
  return false;
}
function confirmed(action){
  if(state?.status!=='active')return false;
  if(action==='deploy')return true;
  if(action==='claim')return state.minted>=1;
  if(action==='unpause')return state.minted===1&&!state.paused;
  return false;
}
function render(){for(const a of actions)$(a).disabled=busy||!!pending||!allowed(a);}
function actionMessage(action){
  if(action==='deploy')return d.tonConnectDeployMessage;
  if(action==='claim')return d.tonConnectCreatorClaimRequest.messages[0];
  if(action==='unpause'){
    const body=beginCell().storeUint(0x554e5053,32).storeUint(BigInt(Date.now()),64).endCell();
    return {address:d.collectionAddressMainnetBounceable,amount:'50000000',payload:body.toBoc().toString('base64')};
  }
  throw Error('Неизвестная операция');
}
async function check(){
  if(checking)return checking;
  checking=(async()=>{
    state=null;render();$('refresh').disabled=true;$('refresh').textContent='Проверяю…';
    try{
      const r=await fetch('https://toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(d.collectionAddressRaw),{cache:'no-store',signal:AbortSignal.timeout(15000)});
      const j=await r.json();if(!r.ok||!j.ok)throw Error('Нет надёжного ответа от TON mainnet');
      const st=j.result?.state;
      if(st==='uninitialized'||st==='nonexist'||!st){state={status:'uninitialized'};$('chain').textContent='Контракт ещё не развёрнут в mainnet.';$('chain').className='muted';}
      else if(st==='active'){
        if(!j.result.code||!j.result.data)throw Error('Активный контракт без code/data');
        if(Cell.fromBase64(j.result.code).hash().toString('hex')!==d.collectionCodeHash)throw Error('Код mainnet-контракта не совпадает с проверенным пакетом');
        const s=Cell.fromBase64(j.result.data).beginParse();
        if(s.loadAddress().toRawString()!==d.ownerAddressRaw)throw Error('Owner mainnet-контракта не совпадает');
        const minted=Number(s.loadUintBig(64));s.loadRef();s.loadRef();s.loadRef();
        if(s.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Treasury mainnet-контракта не совпадает');
        const paused=s.loadBit();state={status:'active',minted,paused};
        $('chain').textContent=`Контракт активен · Выпущено ${minted}/10000 · ${paused?'Публичный минт на паузе':'Публичный минт открыт'}`;
        $('chain').className=!paused&&minted===1?'ok':'muted';
      }else throw Error('Неожиданное состояние адреса: '+st);
      if(pending&&confirmed(pending)){pending=null;$('status').textContent='Операция подтверждена блокчейном.';}
      if(state.status==='active'&&state.minted===1&&!state.paused){$('status').textContent='MAINNET ГОТОВ: NFT #0 выпущен тебе, публичный минт открыт. Теперь можно включать кнопку минта на основном сайте.';$('status').className='ok';}
    }catch(e){state=null;$('chain').textContent='Проверка не завершена: '+(e?.message||e)+'. Отправка заблокирована.';$('chain').className='danger';}
    finally{$('refresh').disabled=false;$('refresh').textContent='Проверить состояние';render();}
  })();
  try{await checking;}finally{checking=null;}
}
async function send(action){
  if(busy||pending||!isOwner())return;
  busy=true;render();
  try{
    await check();if(!allowed(action))throw Error('Операция недоступна для текущего состояния');
    const message=actionMessage(action);
    $('status').className='';$('status').textContent='Подтверди операцию в основном TON-кошельке. Это реальная транзакция.';
    await ui.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-239',from:d.ownerAddressRaw,messages:[message]});
    pending=action;$('status').textContent='Запрос передан кошельку. Дождись подтверждения в блокчейне и нажми «Проверить состояние».';
    await check();
  }catch(e){$('status').className='danger';$('status').textContent='Операция не завершена: '+(e?.message||e);}
  finally{busy=false;render();}
}
async function init(){
  const r=await fetch('deployment.json',{cache:'no-store'});if(!r.ok)throw Error('Mainnet package недоступен');const p=await r.json();
  const init=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());const actual=contractAddress(0,init);
  if(p.network!=='mainnet'||p.revealAt!==1798761600||p.initialPaused!==true||actual.toRawString()!==p.collectionAddressRaw||init.code.hash().toString('hex')!==p.collectionCodeHash)throw Error('Неверный mainnet package');
  if(Address.parseFriendly(p.collectionAddressMainnetBounceable).isTestOnly||Address.parseFriendly(p.collectionAddressMainnetNonBounceable).isTestOnly)throw Error('Mainnet адрес помечен как testnet');
  const data=init.data.beginParse();if(data.loadAddress().toRawString()!==p.ownerAddressRaw||data.loadUintBig(64)!==0n)throw Error('Неверные начальные данные');
  const content=data.loadRef().beginParse();const cc=content.loadRef().beginParse();if(cc.loadUint(8)!==1||cc.loadStringTail()!==p.collectionMetadataIpfs||content.loadRef().beginParse().loadStringTail()!==p.preRevealMetadataRootIpfs)throw Error('Метаданные не совпадают');
  data.loadRef();data.loadRef();if(data.loadAddress().toRawString()!==p.treasuryAddressRaw||!data.loadBit())throw Error('Неверный резерв или стартовая пауза');
  const deploy=p.tonConnectDeployMessage,claim=p.tonConnectCreatorClaimRequest;
  for(const m of [deploy,claim.messages[0]]){const f=Address.parseFriendly(m.address);if(!f.address.equals(actual)||f.isTestOnly)throw Error('Неверный mainnet адрес отправки');}
  if(deploy.amount!=='200000000'||deploy.stateInit!==p.stateInitBocBase64||claim.network!=='-239'||claim.from!==p.treasuryAddressRaw||claim.messages.length!==1||claim.messages[0].amount!=='7100000000')throw Error('Неверные mainnet транзакции');
  const body=Cell.fromBase64(claim.messages[0].payload).beginParse();if(body.loadUint(32)!==0x52535630||body.loadUintBig(64)!==0n||body.remainingBits!==0||body.remainingRefs!==0)throw Error('Неверная команда резерва');
  d=p;$('address').textContent=d.collectionAddressMainnetNonBounceable;
  if(!window.TON_CONNECT_UI)throw Error('TON Connect не загрузился');
  ui=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://coolbears-nfts.com/tonconnect-manifest.json',buttonRootId:'ton-connect'});
  const changed=w=>{wallet=w;$('wallet').textContent=!w?'Подключи закреплённый owner-кошелёк в основной сети TON.':isOwner()?'Owner подтверждён, сеть mainnet.':'Нужен закреплённый owner-кошелёк в основной сети TON.';render();};
  ui.onStatusChange(changed);changed(ui.wallet);
  $('refresh').onclick=check;for(const a of actions)$(a).onclick=()=>send(a);await check();
}
init().catch(e=>{$('status').className='danger';$('status').textContent='Ошибка: '+(e?.message||e);});
