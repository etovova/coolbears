import {Address,Cell,contractAddress,loadStateInit} from 'https://esm.sh/@ton/core@0.62.0?bundle';
const $=id=>document.getElementById(id);
let d,ui,wallet=null,state=null,busy=false,pending=null,checking=null;
const beneficiary=()=>!!d && wallet?.account.chain==='-3' && wallet.account.address.toLowerCase()===d.treasuryAddressRaw.toLowerCase();
function render(){
  const blocked=busy||!!pending||!beneficiary();
  $('deploy').disabled=blocked||state?.status!=='uninitialized';
  $('claim').disabled=blocked||state?.status!=='active'||state?.minted!==0||state?.paused!==true;
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
        if(s.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Получатель резерва не совпадает');
        const paused=s.loadBit();state={status:'active',minted,paused};
        $('chain').textContent=`Контракт активен · Выпущено ${minted}/10000 · ${paused?'Публичный минт на паузе':'Публичный минт открыт'}`;
      }else throw Error('Неожиданное состояние адреса');
      if(pending && (pending==='deploy'?state.status==='active':state.minted>0)){
        $('status').textContent=pending==='deploy'?'Развёртывание подтверждено. Теперь можно получить NFT №0.':'Выпуск подтверждён счётчиком коллекции. Следующий шаг — проверка владельца NFT в блокчейне.';pending=null;
      }
      if(!pending && state.minted>0)$('status').textContent='Резерв уже использован. Повторная отправка заблокирована.';
    }catch(e){state=null;$('chain').textContent='Проверка не завершена: '+e.message+'. Отправка заблокирована; повтори проверку.';}
    finally{$('refresh').disabled=false;$('refresh').textContent='Проверить состояние';render();}
  })();
  try{await checking;}finally{checking=null;}
}
async function send(action){
  if(busy||pending||!beneficiary())return;
  busy=true;render();
  try{
    await check();if(!beneficiary())throw Error('Нужен закреплённый кошелёк в testnet');
    if(action==='deploy'&&state?.status!=='uninitialized')throw Error('Развёртывание сейчас недоступно');
    if(action==='claim'&&(state?.status!=='active'||state.minted!==0||!state.paused))throw Error('Минт резерва сейчас недоступен');
    const message=action==='deploy'?d.tonConnectDeployMessage:d.tonConnectCreatorClaimRequest.messages[0];
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
  data.loadRef();data.loadRef();if(data.loadAddress().toRawString()!==p.treasuryAddressRaw||!data.loadBit())throw Error('Неверный резерв или пауза');
  const deploy=p.tonConnectDeployMessage,claim=p.tonConnectCreatorClaimRequest;
  for(const m of [deploy,claim.messages[0]])if(!Address.parse(m.address).equals(actual)||!Address.parseFriendly(m.address).isTestOnly)throw Error('Неверный адрес отправки');
  if(deploy.amount!=='200000000'||deploy.stateInit!==p.stateInitBocBase64||claim.network!=='-3'||claim.from!==p.treasuryAddressRaw||claim.messages.length!==1||claim.messages[0].amount!=='7100000000')throw Error('Неверная транзакция');
  const body=Cell.fromBase64(claim.messages[0].payload).beginParse();if(body.loadUint(32)!==0x52535630||body.loadUintBig(64)!==0n||body.remainingBits!==0||body.remainingRefs!==0)throw Error('Неверная команда резерва');
  d=p;$('address').textContent=d.collectionAddressTestnetNonBounceable;
  if(!window.TON_CONNECT_UI)throw Error('Подключение кошелька не загрузилось. Обнови страницу.');
  ui=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://coolbears-nfts.com/tonconnect-manifest.json',buttonRootId:'ton-connect'});
  const changed=w=>{wallet=w;$('wallet').textContent=!w?'Подключи кошелёк владельца в testnet.':beneficiary()?'Закреплённый кошелёк подтверждён, сеть testnet.':'Нужен закреплённый кошелёк в testnet.';render();};ui.onStatusChange(changed);changed(ui.wallet);
  $('refresh').onclick=check;$('deploy').onclick=()=>send('deploy');$('claim').onclick=()=>send('claim');await check();
}
init().catch(e=>{$('status').textContent='Ошибка: '+e.message;});
