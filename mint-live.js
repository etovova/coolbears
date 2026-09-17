(() => {
  const cfg = window.COOLBEARS_CONFIG || {};
  if (cfg.demoMode || cfg.network !== 'mainnet' || !cfg.mintContractAddress) return;

  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const labels = {
    en:{hero:'Mint is open. Each NFT costs 7 GRAM (TON), plus creation reserve and network fees. Reveal is planned for January 1, 2027.',heroBtn:'MINT NOW',title:'MINT<br>YOUR COOLBEAR',text:'Choose between 1 and 50 NFTs. There is no lifetime wallet limit. Each NFT costs 7 GRAM (TON).',connect:'CONNECT WALLET TO MINT',mint:'MINT {n} NFT — {amount} TON',fee:'The signed transaction sends 7.10 TON per NFT: 7 TON mint price, 0.05 TON NFT creation reserve and 0.05 TON execution buffer. Wallet/network fees are additional. Unused buffer remains in the collection contract.',checking:'CHECKING MAINNET…',paused:'MINT PAUSED',sold:'SOLD OUT',wrong:'SWITCH WALLET TO TON MAINNET',sent:'Request returned by the wallet. Execution is not yet confirmed. Check your transaction and NFT receipt in the wallet before retrying.',activity:'Collection activity detected. This alone does not confirm your mint. Check your transaction and NFT receipt in the wallet.',failed:'Mint was not completed: '},
    ru:{hero:'Минт открыт. Цена одного NFT — 7 GRAM (TON), плюс резерв на создание и комиссия сети. Раскрытие запланировано на 1 января 2027 года.',heroBtn:'ЗАМИНТИТЬ',title:'ЗАМИНТЬ<br>СВОЕГО COOLBEAR',text:'Выбери от 1 до 50 NFT за транзакцию. Общего лимита на кошелёк нет. Цена одного NFT — 7 GRAM (TON).',connect:'ПОДКЛЮЧИТЬ КОШЕЛЁК',mint:'ЗАМИНТИТЬ {n} NFT — {amount} TON',fee:'Подписываемая транзакция отправляет 7,10 TON за NFT: 7 TON — цена минта, 0,05 TON — создание NFT и 0,05 TON — запас на выполнение. Комиссия кошелька/сети оплачивается дополнительно. Неиспользованный запас остаётся в контракте коллекции.',checking:'ПРОВЕРЯЮ MAINNET…',paused:'МИНТ НА ПАУЗЕ',sold:'РАСПРОДАНО',wrong:'ПЕРЕКЛЮЧИ КОШЕЛЁК НА TON MAINNET',sent:'Запрос передан кошельку. Выполнение ещё не подтверждено. Перед повторной отправкой проверь транзакцию и получение NFT в кошельке.',activity:'В коллекции появились новые NFT. Это не подтверждает именно твой минт. Проверь транзакцию и получение NFT в кошельке.',failed:'Минт не завершён: '},
    zh:{hero:'铸造已开放。每个 NFT 价格为 7 GRAM (TON)，另加创建储备和网络费用。计划于 2027 年 1 月 1 日揭晓。',heroBtn:'立即铸造',title:'铸造你的<br>COOLBEAR',text:'每笔交易可选择 1–50 个 NFT。钱包没有总数量限制。每个 NFT 价格为 7 GRAM (TON)。',connect:'连接钱包开始铸造',mint:'铸造 {n} 个 NFT — {amount} TON',fee:'签名交易每个 NFT 发送 7.10 TON：7 TON 为铸造价格，0.05 TON 用于创建 NFT，0.05 TON 为执行缓冲。钱包/网络费用另计。未使用的缓冲留在系列合约中。',checking:'正在检查主网…',paused:'铸造已暂停',sold:'已售罄',wrong:'请将钱包切换到 TON 主网',sent:'请求已交给钱包，执行结果尚未确认。重试前请在钱包中检查交易和 NFT 是否到账。',activity:'检测到系列新增 NFT，但这不能确认您的铸造。请在钱包中检查交易和 NFT 是否到账。',failed:'铸造未完成：'}
  };
  const lang=()=>{const x=localStorage.getItem('coolbears_lang')||'en';return labels[x]?x:'en';};
  const t=k=>labels[lang()][k]||labels.en[k];
  let ui=null, wallet=null, busy=false, state=null, core=null, applying=false;
  const mintBtn=$('#mintBtn'), qty=$('#qty'), minted=$('#minted'), note=$('#mintNote');

  async function loadSdk(){
    if(window.TON_CONNECT_UI)return;
    for(const src of ['https://cdn.jsdelivr.net/npm/@tonconnect/ui@3.0.2/dist/tonconnect-ui.min.js','https://unpkg.com/@tonconnect/ui@3.0.2/dist/tonconnect-ui.min.js']){
      try{await new Promise((ok,bad)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=bad;document.head.append(s)});if(window.TON_CONNECT_UI)return;}catch{}
    }
    throw Error('TON Connect unavailable');
  }
  async function getCore(){return core||(core=await import('https://esm.sh/@ton/core@0.62.0?bundle'));}
  function n(){return Math.max(1,Math.min(Number(cfg.maxPerTransaction||50),parseInt(qty?.value||'1',10)||1));}
  function amountTon(count=n()){return (count*Number(cfg.mintPaymentPerNftTon||7.1)).toFixed(2).replace(/\.00$/,'');}
  function setText(sel,key){const el=$(sel);if(el)el.innerHTML=t(key);}
  function refreshText(){
    if(applying)return;applying=true;
    try{
      setText('[data-i18n="heroText"]','hero');
      setText('[data-i18n="mintNow"]','heroBtn');
      setText('[data-i18n="mintTitle"]','title');
      setText('[data-i18n="mintText"]','text');
      const fee=$('[data-i18n="mintFeeNote"]');if(fee)fee.textContent=t('fee');
      if(mintBtn){
        if(busy){mintBtn.textContent=t('checking');mintBtn.disabled=true;}
        else if(state?.soldOut){mintBtn.textContent=t('sold');mintBtn.disabled=true;}
        else if(state?.paused){mintBtn.textContent=t('paused');mintBtn.disabled=true;}
        else if(wallet&&wallet.account.chain!=='-239'){mintBtn.textContent=t('wrong');mintBtn.disabled=false;}
        else if(!wallet){mintBtn.textContent=t('connect');mintBtn.disabled=false;}
        else{mintBtn.textContent=t('mint').replace('{n}',String(n())).replace('{amount}',amountTon());mintBtn.disabled=false;}
      }
    }finally{applying=false;}
  }
  function parseLive(j,Cell){
    if(!j?.ok||j.result?.state!=='active'||!j.result.data||!j.result.code)throw Error('Mint contract is not active');
    if(cfg.collectionCodeHash&&Cell.fromBase64(j.result.code).hash().toString('hex')!==cfg.collectionCodeHash)throw Error('Mainnet contract code mismatch');
    const s=Cell.fromBase64(j.result.data).beginParse();
    const owner=s.loadAddress();const next=Number(s.loadUintBig(64));s.loadRef();s.loadRef();s.loadRef();const treasury=s.loadAddress();const paused=s.loadBit();
    if(!Number.isSafeInteger(next)||next<0||next>Number(cfg.supply||10000)||s.remainingBits!==0||s.remainingRefs!==0)throw Error('Invalid mainnet mint state');
    if(cfg.treasuryAddress&&treasury.toRawString()!==core.Address.parse(cfg.treasuryAddress).toRawString())throw Error('Treasury mismatch');
    return {owner,next,paused,soldOut:next>=Number(cfg.supply||10000)};
  }
  async function checkLive(){
    const c=await getCore();
    const r=await fetch('https://toncenter.com/api/v2/getAddressInformation?address='+encodeURIComponent(cfg.mintContractAddress),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    const j=await r.json();if(!r.ok)throw Error('TON mainnet status unavailable');
    state=parseLive(j,c.Cell);
    if(minted)minted.textContent=`${state.next.toLocaleString('en-US')} / ${Number(cfg.supply||10000).toLocaleString('en-US')}`;
    refreshText();return state;
  }
  async function ensureUi(){
    if(ui)return ui;await loadSdk();
    ui=new window.TON_CONNECT_UI.TonConnectUI({manifestUrl:new URL('tonconnect-manifest.json',location.href).href});
    const changed=w=>{wallet=w||null;refreshText();};ui.onStatusChange(changed);changed(ui.wallet);return ui;
  }
  // A global supply counter cannot prove the outcome of this wallet transaction.
  // Poll only to refresh collection activity; never label it a successful mint.
  async function observeCollectionActivity(before,count){
    for(let i=0;i<12;i++){await sleep(4000);try{const s=await checkLive();if(s.next>=before+count)return true;}catch{}}
    return false;
  }
  async function approvedRelease(){
    const {validateLaunch}=await import('./release-guard.mjs');
    const [pr,sr]=await Promise.all([fetch('mainnet/owner/deployment.json',{cache:'no-store',signal:AbortSignal.timeout(15000)}),fetch('release/launch-state.json',{cache:'no-store',signal:AbortSignal.timeout(15000)})]);
    if(!pr.ok||!sr.ok)throw Error('Launch approval unavailable');
    const raw=await pr.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),x=>x.toString(16).padStart(2,'0')).join('');
    const p=JSON.parse(new TextDecoder().decode(raw));
    if(!validateLaunch(cfg,p,await sr.json(),hash).sales)throw Error('Public mint has not been approved');
    return p;
  }
  async function mint(){
    if(busy)return;busy=true;refreshText();
    try{
      const tc=await ensureUi();
      if(!wallet){await tc.openModal();return;}
      if(wallet.account.chain!=='-239'){await tc.openModal();return;}
      const c=await getCore();
      const friendly=c.Address.parseFriendly(cfg.mintContractAddress);if(friendly.isTestOnly)throw Error('Configured destination is testnet');
      await approvedRelease();
      const count=n();const s=await checkLive();
      if(s.next<1)throw Error('Creator reservation is not confirmed');if(s.paused)throw Error(t('paused'));if(s.soldOut)throw Error(t('sold'));if(s.next+count>Number(cfg.supply||10000))throw Error('Not enough NFTs remaining');
      const body=c.beginCell().storeUint(0x4d494e54,32).storeUint(BigInt(Date.now()),64).storeUint(count,8).endCell();
      const amount=(BigInt(count)*BigInt(cfg.mintPaymentPerNftNano||7100000000)).toString();
      if(note)note.textContent=t('sent');
      await tc.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-239',from:wallet.account.address,messages:[{address:cfg.mintContractAddress,amount,payload:body.toBoc().toString('base64')}]});
      if(note)note.textContent=t('sent');
      const activity=await observeCollectionActivity(s.next,count);if(note)note.textContent=activity?t('activity'):t('sent');
    }catch(e){if(note)note.textContent=t('failed')+(e?.message||e);}
    finally{busy=false;refreshText();}
  }

  mintBtn?.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();mint();},true);
  for(const sel of ['#minus','#plus','.bear-lang'])document.addEventListener('click',e=>{if(e.target.closest(sel))setTimeout(refreshText,0)},true);
  qty?.addEventListener('input',()=>setTimeout(refreshText,0));
  ensureUi().then(()=>checkLive()).catch(e=>{if(note)note.textContent=t('failed')+(e?.message||e);refreshText();});
  refreshText();
})();
