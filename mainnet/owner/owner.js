import {beginCell,Address,Cell,contractAddress,loadStateInit} from 'https://esm.sh/@ton/core@0.62.0?bundle';
const $=id=>document.getElementById(id);
let d,ui,wallet=null,state=null,busy=false,pending=null,checking=null;
let expectedContentHash,expectedItemCodeHash,expectedRoyaltyHash;
const isOwner=()=>{try{return !!d&&wallet?.account.chain==='-239'&&Address.parse(wallet.account.address).toRawString()===d.ownerAddressRaw;}catch{return false;}};
const actions=['deploy','claim','unpause'];
function allowed(action){
  if(!isOwner()||!state)return false;
  if(action==='deploy')return state.status==='uninitialized';
  if(state.status!=='active')return false;
  if(action==='claim')return state.minted===0&&state.paused;
  if(action==='unpause')return state.minted===1&&state.paused&&state.creatorVerified===true;
  return false;
}
function confirmed(action){
  if(state?.status!=='active')return false;
  if(action==='deploy')return true;
  if(action==='claim')return state.minted>=1&&state.creatorVerified===true;
  if(action==='unpause')return state.minted>=1&&!state.paused&&state.creatorVerified===true;
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
// Read-only checks: never send a transaction or infer success from a counter alone.
async function addressInfo(address){
  for(let attempt=0;attempt<3;attempt++){
    const r=await fetch('https://toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(address),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if((r.status===429||r.status===503)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));continue;}
    const j=await r.json();
    if(!r.ok||j.ok!==true||!j.result||typeof j.result.state!=='string')throw Error('Нет надёжного ответа от TON mainnet');
    if(!['active','uninitialized','nonexist','frozen'].includes(j.result.state))throw Error('Неизвестное состояние адреса: '+j.result.state);
    return j.result;
  }
  throw Error('TON mainnet временно недоступен');
}
async function verifyCreator(itemCode){
  // Same StateInit as cb_item_state_init() in the checked collection source.
  const collection=Address.parse(d.collectionAddressRaw);
  const initialData=beginCell().storeUint(0,64).storeAddress(collection).endCell();
  const nft=contractAddress(0,{code:itemCode,data:initialData});
  const info=await addressInfo(nft.toRawString());
  if(info.state==='uninitialized'||info.state==='nonexist')return false;
  if(info.state!=='active'||!info.code||!info.data)throw Error('Резервный NFT #0 ещё не подтверждён');
  if(Cell.fromBase64(info.code).hash().toString('hex')!==expectedItemCodeHash)throw Error('Код NFT #0 не совпадает с пакетом');
  const data=Cell.fromBase64(info.data).beginParse();
  if(data.loadUintBig(64)!==0n||!data.loadAddress().equals(collection))throw Error('Индекс или коллекция резервного NFT не совпадают');
  if(data.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('NFT #0 не принадлежит закреплённому кошельку');
  const content=data.loadRef().beginParse().loadStringTail();
  if(content!=='0000.json'||data.remainingBits!==0||data.remainingRefs!==0)throw Error('Некорректные данные резервного NFT #0');
  return true;
}
async function check(){
  if(checking)return checking;
  checking=(async()=>{
    state=null;render();$('refresh').disabled=true;$('refresh').textContent='Проверяю…';
    try{
      const info=await addressInfo(d.collectionAddressRaw);
      const st=info.state;
      if(st==='uninitialized'||st==='nonexist'){
        state={status:'uninitialized',creatorVerified:false};
        $('chain').textContent='Контракт ещё не развёрнут в mainnet.';$('chain').className='muted';
      }else if(st==='active'){
        if(!info.code||!info.data)throw Error('Активный контракт без code/data');
        if(Cell.fromBase64(info.code).hash().toString('hex')!==d.collectionCodeHash)throw Error('Код mainnet-контракта не совпадает с проверенным пакетом');
        const s=Cell.fromBase64(info.data).beginParse();
        if(s.loadAddress().toRawString()!==d.ownerAddressRaw)throw Error('Owner mainnet-контракта не совпадает');
        const minted=Number(s.loadUintBig(64));
        if(!Number.isSafeInteger(minted)||minted<0||minted>d.supply)throw Error('Неверный счётчик NFT');
        const content=s.loadRef(),itemCode=s.loadRef(),royalty=s.loadRef();
        if(content.hash().toString('hex')!==expectedContentHash)throw Error('Pre-reveal metadata контракта не совпадают с пакетом');
        if(itemCode.hash().toString('hex')!==expectedItemCodeHash)throw Error('Код NFT item не совпадает с пакетом');
        if(royalty.hash().toString('hex')!==expectedRoyaltyHash)throw Error('Royalty контракта не совпадает с пакетом');
        if(s.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Treasury mainnet-контракта не совпадает');
        const paused=s.loadBit();
        if(s.remainingBits!==0||s.remainingRefs!==0)throw Error('Неожиданные данные контракта');
        const creatorVerified=minted>0?await verifyCreator(itemCode):false;
        state={status:'active',minted,paused,creatorVerified};
        $('chain').textContent=`Контракт активен · Выпущено ${minted}/10000 · ${paused?'Публичный минт на паузе':'Публичный минт открыт'} · Резерв #0: ${creatorVerified?'владелец подтверждён':'ещё не подтверждён'}`;
        $('chain').className=!paused&&creatorVerified?'ok':'muted';
      }else throw Error('Контракт заморожен; операции заблокированы');
      if(pending&&confirmed(pending)){pending=null;$('status').className='ok';$('status').textContent='Операция подтверждена блокчейном.';}
      if(state.status==='active'&&state.minted>=1&&!state.paused&&state.creatorVerified){
        $('status').textContent='Резерв #0 подтверждён на твоём кошельке, контракт открыт. Основной сайт включается отдельно после итоговой проверки запуска.';$('status').className='ok';
      }
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
    if(action==='unpause'&&!window.confirm('Это откроет публичный минт в блокчейне. Даже при выключенной кнопке сайта контракт сможет принимать прямые запросы. Продолжить?'))return;
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
  const itemCode=data.loadRef(),royalty=data.loadRef();if(data.loadAddress().toRawString()!==p.treasuryAddressRaw||!data.loadBit()||data.remainingBits!==0||data.remainingRefs!==0)throw Error('Неверный резерв или стартовая пауза');
  if(p.supply!==10000||p.priceNanoTon!==7000000000||p.maxPerTransaction!==50||p.royaltyBps!==700)throw Error('Неверные параметры минта');
  const rs=royalty.beginParse();if(rs.loadUint(16)!==7||rs.loadUint(16)!==100||rs.loadAddress().toRawString()!==p.treasuryAddressRaw||rs.remainingBits!==0||rs.remainingRefs!==0)throw Error('Неверные параметры royalty');
  const initial=init.data.beginParse();initial.loadAddress();initial.loadUintBig(64);
  expectedContentHash=initial.loadRef().hash().toString('hex');expectedItemCodeHash=itemCode.hash().toString('hex');expectedRoyaltyHash=royalty.hash().toString('hex');
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
