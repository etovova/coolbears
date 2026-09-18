import {beginCell,Address,Cell,contractAddress,loadStateInit} from 'https://esm.sh/@ton/core@0.63.1?bundle';
const $=id=>document.getElementById(id);
const PACKAGE_SHA='763ad4e4c4e7c230652a5b44d18ef175d1abed4d989cef7b0d0116fb3e7a684f';
const REVISION='v3-glasses-correction-1';
let d,ui,wallet=null,state=null,busy=false,pending=null,checking=null,gate=null,releaseState=null;
let expectedContentHash,expectedItemCodeHash,expectedRoyaltyHash;
const actions=['deploy','claim','unpause'];
const isOwner=()=>{try{return !!d&&wallet?.account.chain==='-239'&&Address.parse(wallet.account.address).toRawString()===d.ownerAddressRaw;}catch{return false;}};
const hex=buffer=>Array.from(new Uint8Array(buffer),x=>x.toString(16).padStart(2,'0')).join('');
async function sha256(raw){return hex(await crypto.subtle.digest('SHA-256',raw));}

function allowed(action){
  if(!isOwner()||!state||!gate?.setup)return false;
  if(action==='deploy')return gate.phase==='prepared'&&state.status==='uninitialized';
  if(state.status!=='active')return false;
  if(action==='claim')return ['prepared','approved','live'].includes(gate.phase)&&state.minted===0&&state.paused===true;
  if(action==='unpause')return ['approved','live'].includes(gate.phase)&&releaseState?.publicMintApproved===true&&state.minted>=1&&state.paused===true&&state.creatorVerified===true;
  return false;
}
function confirmed(action){
  if(state?.status!=='active')return false;
  if(action==='deploy')return true;
  if(action==='claim')return state.minted>=1&&state.creatorVerified===true;
  if(action==='unpause')return state.minted>=1&&!state.paused&&state.creatorVerified===true;
  return false;
}
function render(){
  const setup=gate?.setup===true;
  $('release-hold').disabled=!setup;
  for(const a of actions)$ (a).disabled=busy||!!pending||!allowed(a);
}
function actionMessage(action){
  if(action==='deploy')return d.tonConnectDeployMessage;
  if(action==='claim')return d.tonConnectCreatorClaimRequest.messages[0];
  if(action==='unpause'){
    const body=beginCell().storeUint(0x554e5053,32).storeUint(BigInt(Date.now()),64).endCell();
    return {address:d.collectionAddressMainnetBounceable,amount:'50000000',payload:body.toBoc().toString('base64')};
  }
  throw Error('Неизвестная операция');
}

async function fetchJsonBytes(url){
  const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Пакет запуска недоступен');
  const raw=await r.arrayBuffer();
  return {raw,json:JSON.parse(new TextDecoder().decode(raw)),hash:await sha256(raw)};
}
async function refreshGate(){
  const dep=await fetchJsonBytes('deployment.json');
  const cand=await fetchJsonBytes('../../launch/candidate.json');
  if(dep.hash!==PACKAGE_SHA||cand.hash!==PACKAGE_SHA||dep.hash!==cand.hash)throw Error('Mainnet package не совпадает с corrected candidate');
  if(dep.json.collectionRevision!==REVISION||cand.json.collectionRevision!==REVISION)throw Error('Неверная ревизия mainnet package');
  if(d&&dep.json.stateInitBocBase64!==d.stateInitBocBase64)throw Error('Mainnet package изменился. Перезагрузи страницу');
  d=dep.json;

  const sr=await fetch('../../release/launch-state.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!sr.ok)throw Error('Release state недоступен');
  releaseState=await sr.json();

  const {validateLaunch,OWNER_FRIENDLY}=await import('../../release-guard.mjs');
  const c={
    network:'mainnet',priceTon:7,supply:10000,royaltyPercent:7,maxPerTransaction:50,
    revealDate:'2027-01-01',mintPaymentPerNftTon:7.1,mintPaymentPerNftNano:7100000000,
    treasuryAddress:OWNER_FRIENDLY,royaltyAddress:OWNER_FRIENDLY,
    collectionAddress:d.collectionAddressMainnetNonBounceable,
    mintContractAddress:d.collectionAddressMainnetBounceable,
    collectionCodeHash:d.collectionCodeHash,
    demoMode:releaseState.phase!=='live'
  };
  gate=validateLaunch(c,d,releaseState,dep.hash);
  render();
  return gate;
}

// Read-only checks. Never infer success from a counter alone.
async function addressInfo(address){
  for(let attempt=0;attempt<3;attempt++){
    const r=await fetch('https://toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(address),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if([429,503].includes(r.status)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));continue;}
    const j=await r.json();
    if(!r.ok||j.ok!==true||!j.result||typeof j.result.state!=='string')throw Error('Нет надёжного ответа от TON mainnet');
    if(!['active','uninitialized','nonexist','frozen'].includes(j.result.state))throw Error('Неизвестное состояние адреса: '+j.result.state);
    return j.result;
  }
  throw Error('TON mainnet временно недоступен');
}
async function verifyCreator(itemCode){
  const collection=Address.parse(d.collectionAddressRaw);
  const initialData=beginCell().storeUint(0,64).storeAddress(collection).endCell();
  const nft=contractAddress(0,{code:itemCode,data:initialData});
  const info=await addressInfo(nft.toRawString());
  if(['uninitialized','nonexist'].includes(info.state))return false;
  if(info.state!=='active'||!info.code||!info.data)throw Error('Резервный NFT #0000 ещё не подтверждён');
  if(Cell.fromBase64(info.code).hash().toString('hex')!==expectedItemCodeHash)throw Error('Код NFT #0000 не совпадает с пакетом');
  const data=Cell.fromBase64(info.data).beginParse();
  if(data.loadUintBig(64)!==0n||!data.loadAddress().equals(collection))throw Error('Индекс или коллекция NFT #0000 не совпадают');
  if(data.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('NFT #0000 не принадлежит закреплённому кошельку');
  const suffix=data.loadRef().beginParse().loadStringTail();
  if(suffix!=='0000.json'||data.remainingBits!==0||data.remainingRefs!==0)throw Error('Некорректные данные NFT #0000');
  return true;
}

async function check(){
  if(checking)return checking;
  checking=(async()=>{
    state=null;render();$('refresh').disabled=true;$('refresh').textContent='Проверяю…';
    try{
      await refreshGate();
      const info=await addressInfo(d.collectionAddressRaw);
      const st=info.state;
      if(['uninitialized','nonexist'].includes(st)){
        state={status:'uninitialized',creatorVerified:false};
        $('chain').textContent='Corrected-контракт ещё не развёрнут в mainnet.';
        $('chain').className='muted';
      }else if(st==='active'){
        if(!info.code||!info.data)throw Error('Активный контракт без code/data');
        if(Cell.fromBase64(info.code).hash().toString('hex')!==d.collectionCodeHash)throw Error('Код mainnet-контракта не совпадает с corrected package');
        const s=Cell.fromBase64(info.data).beginParse();
        if(s.loadAddress().toRawString()!==d.ownerAddressRaw)throw Error('Owner mainnet-контракта не совпадает');
        const minted=Number(s.loadUintBig(64));
        if(!Number.isSafeInteger(minted)||minted<0||minted>d.supply)throw Error('Неверный счётчик NFT');
        const content=s.loadRef(),itemCode=s.loadRef(),royalty=s.loadRef();
        if(content.hash().toString('hex')!==expectedContentHash)throw Error('Pre-reveal metadata контракта не совпадают');
        if(itemCode.hash().toString('hex')!==expectedItemCodeHash)throw Error('Код NFT item не совпадает');
        if(royalty.hash().toString('hex')!==expectedRoyaltyHash)throw Error('Royalty контракта не совпадает');
        if(s.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Treasury mainnet-контракта не совпадает');
        const paused=s.loadBit(),revealed=s.loadBit(),commitment=s.loadUintBig(256);
        if(s.remainingBits!==0||s.remainingRefs!==0)throw Error('Неожиданные данные контракта');
        if(revealed)throw Error('Контракт неожиданно уже раскрыт');
        if(commitment!==BigInt('0x'+d.finalContentCommitment))throw Error('Reveal commitment не совпадает с corrected package');
        const creatorVerified=minted>0?await verifyCreator(itemCode):false;
        state={status:'active',minted,paused,creatorVerified,revealed:false};
        $('chain').textContent=`Контракт активен · Выпущено ${minted}/10000 · ${paused?'Публичный минт на паузе':'Публичный минт открыт'} · #0000: ${creatorVerified?'владелец подтверждён':'ещё не подтверждён'}`;
        $('chain').className=paused?'muted':'ok';
      }else throw Error('Контракт заморожен; операции заблокированы');

      if(pending&&confirmed(pending)){
        pending=null;
        $('status').className='ok';
        $('status').textContent='Операция подтверждена блокчейном.';
      }
      if(state.status==='active'&&state.minted>=1&&state.paused&&state.creatorVerified){
        $('status').textContent='Mainnet #0000 подтверждён. Публичный минт остаётся на паузе до отдельного разрешения.';
        $('status').className='ok';
      }
    }catch(e){
      state=null;
      $('chain').textContent='Проверка не завершена: '+(e?.message||e)+'. Отправка заблокирована.';
      $('chain').className='danger';
    }finally{
      $('refresh').disabled=false;$('refresh').textContent='Проверить состояние';render();
    }
  })();
  try{await checking;}finally{checking=null;}
}

async function releaseAllows(action){
  await refreshGate();
  const {canOperate}=await import('../../release-guard.mjs');
  return canOperate(action,gate,state,isOwner());
}
async function send(action){
  if(busy||pending||!isOwner())return;
  busy=true;render();
  try{
    await check();
    if(!allowed(action))throw Error('Операция недоступна для текущего состояния');
    if(!(await releaseAllows(action)))throw Error('Release gate не разрешает эту операцию');
    if(action==='unpause'&&!window.confirm('Это откроет публичный mint в MAINNET. Продолжить?'))return;
    const message=actionMessage(action);
    $('status').className='';
    $('status').textContent='Подтверди операцию в основном TON-кошельке. Это реальная транзакция.';
    await ui.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-239',from:d.ownerAddressRaw,messages:[message]});
    pending=action;
    $('status').textContent='Запрос передан кошельку. Дождись подтверждения в блокчейне и нажми «Проверить состояние».';
    await new Promise(r=>setTimeout(r,3500));
    await check();
  }catch(e){
    $('status').className='danger';
    $('status').textContent='Операция не завершена: '+(e?.message||e);
  }finally{busy=false;render();}
}

async function init(){
  await refreshGate();
  const init=loadStateInit(Cell.fromBase64(d.stateInitBocBase64).beginParse());
  const actual=contractAddress(0,init);
  if(d.network!=='mainnet'||d.collectionRevision!==REVISION||d.revealAt!==1798761600||d.initialPaused!==true||actual.toRawString()!==d.collectionAddressRaw||init.code.hash().toString('hex')!==d.collectionCodeHash)throw Error('Неверный corrected mainnet package');
  if(Address.parseFriendly(d.collectionAddressMainnetBounceable).isTestOnly||Address.parseFriendly(d.collectionAddressMainnetNonBounceable).isTestOnly)throw Error('Mainnet адрес помечен как testnet');

  const data=init.data.beginParse();
  if(data.loadAddress().toRawString()!==d.ownerAddressRaw||data.loadUintBig(64)!==0n)throw Error('Неверные начальные данные');
  const content=data.loadRef(),itemCode=data.loadRef(),royalty=data.loadRef();
  if(data.loadAddress().toRawString()!==d.treasuryAddressRaw)throw Error('Неверный treasury');
  if(!data.loadBit())throw Error('Контракт должен стартовать на паузе');
  if(data.loadBit())throw Error('Контракт не должен стартовать раскрытым');
  if(data.loadUintBig(256)!==BigInt('0x'+d.finalContentCommitment)||data.remainingBits!==0||data.remainingRefs!==0)throw Error('Неверный reveal commitment/state');

  const cs=content.beginParse();
  const cc=cs.loadRef().beginParse();
  if(cc.loadUint(8)!==1||cc.loadStringTail()!==d.collectionMetadataIpfs||cs.loadRef().beginParse().loadStringTail()!==d.preRevealMetadataRootIpfs||cs.remainingBits!==0||cs.remainingRefs!==0)throw Error('Метаданные не совпадают');
  if(itemCode.hash().toString('hex')!==d.nftItemCodeHash)throw Error('NFT item code hash не совпадает');
  const rs=royalty.beginParse();
  if(rs.loadUint(16)!==7||rs.loadUint(16)!==100||rs.loadAddress().toRawString()!==d.treasuryAddressRaw||rs.remainingBits!==0||rs.remainingRefs!==0)throw Error('Royalty не совпадает');
  expectedContentHash=content.hash().toString('hex');
  expectedItemCodeHash=itemCode.hash().toString('hex');
  expectedRoyaltyHash=royalty.hash().toString('hex');

  const deploy=d.tonConnectDeployMessage,claim=d.tonConnectCreatorClaimRequest;
  for(const m of [deploy,claim.messages[0]]){
    const f=Address.parseFriendly(m.address);
    if(!f.address.equals(actual)||f.isTestOnly)throw Error('Неверный mainnet адрес отправки');
  }
  if(deploy.amount!=='300000000'||deploy.stateInit!==d.stateInitBocBase64)throw Error('Неверный corrected deploy request');
  if(claim.network!=='-239'||claim.from!==d.treasuryAddressRaw||claim.messages.length!==1||claim.messages[0].amount!=='7100000000')throw Error('Неверный creator claim request');
  const body=Cell.fromBase64(claim.messages[0].payload).beginParse();
  if(body.loadUint(32)!==0x52535630||body.loadUintBig(64)!==0n||body.remainingBits!==0||body.remainingRefs!==0)throw Error('Неверная команда #0000');

  $('address').textContent=d.collectionAddressMainnetNonBounceable;
  if(!window.TON_CONNECT_UI)throw Error('TON Connect не загрузился');
  ui=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://coolbears-nfts.com/tonconnect-manifest.json',buttonRootId:'ton-connect'});
  const changed=w=>{
    wallet=w;
    $('wallet').textContent=!w?'Подключи закреплённый owner-кошелёк в MAINNET.':isOwner()?'Owner подтверждён, сеть MAINNET.':'Нужен закреплённый owner-кошелёк в MAINNET.';
    render();
  };
  ui.onStatusChange(changed);changed(ui.wallet);
  $('refresh').onclick=check;
  for(const a of actions)$(a).onclick=()=>send(a);
  await check();
}
init().catch(e=>{$('status').className='danger';$('status').textContent='Ошибка: '+(e?.message||e);});
