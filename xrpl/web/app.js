import {mountRarity} from './rarity.mjs';
import {walletAdapter} from './walletconnect.mjs';
import * as xaman from './xaman.mjs';
import translations from './translations.mjs';
const el=id=>document.getElementById(id);
const buy=el('buy'), message=el('message'), dialog=el('walletDialog'), receipt=el('receipt');
const storage={get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set(k,v){localStorage.setItem(k,JSON.stringify(v))}};
let lang=storage.get('coolbears.xrpl.language') || navigator.language.slice(0,2);
if(!translations[lang])lang='en';
const copy={
 en:['Sales closed','Buy for','Check transaction','Connect wallet','Select a wallet on','Waiting for ledger confirmation.','Purchase confirmed.','Next NFT','Unavailable','Network fee applies.','Transaction declined or expired.'],
 ru:['Продажи закрыты','Купить за','Проверить транзакцию','Подключить кошелёк','Выберите кошелёк в сети','Ожидаем подтверждения сети.','Покупка подтверждена.','Следующий NFT','Недоступно','Также взимается комиссия сети.','Транзакция отклонена или срок истёк.'],
 zh:['暂未开售','购买价格','查看交易','连接钱包','选择钱包网络','等待账本确认。','购买已确认。','下一个 NFT','暂不可用','另收网络费用。','交易已拒绝或过期。']
};
let status,account,wallet,busy=false,pending,order,rankingVisible=false;
let updateRarityLanguage, pairing, pairingUri;
const wc=walletAdapter({origin:location.origin,onChange(buyer){
 if(wallet==='wc'){account=buyer;if(!buyer)wallet=null;render();}
}});
const wcText={
 en:{hint:'On this phone, open your wallet below. On another device, scan the QR code.',copy:'Copy link',copied:'Copied',soon:'Coming soon',open:'Open',manual:'Select and copy the pairing link'},
 ru:{hint:'На этом телефоне нажмите кнопку своего кошелька. С другого устройства отсканируйте QR-код.',copy:'Скопировать ссылку',copied:'Скопировано',soon:'Скоро',open:'Открыть',manual:'Выделите и скопируйте ссылку для подключения'},
 zh:{hint:'在本机上，点击下方的钱包按钮。在其他设备上，请扫描二维码。',copy:'复制链接',copied:'已复制',soon:'即将开放',open:'打开',manual:'请选择并复制配对链接'}
};
function closePairing(){
 pairing?.abort();pairing=null;pairingUri=null;
 if(!el('wcPair'))return;
 el('wcPair').hidden=true;
 el('wcQR').removeAttribute('src');
 el('wcOpen').removeAttribute('href');
 el('wcJoey')?.removeAttribute('href');
 if(el('wcManual')){
   el('wcManual').hidden=true;
   el('wcLink').value='';
 }
}
function showPairing(uri,image){
 if(!dialog.open)dialog.showModal();
 pairingUri=uri;el('wcQR').src=image;
 const encoded=encodeURIComponent(uri);
 el('wcOpen').href='bifrostwallet://wc?uri='+encoded;
 if(el('wcJoey'))el('wcJoey').href='joey://settings/wc?uri='+encoded;
 el('wcCopy').textContent=wcText[lang].copy;
 el('wcPair').hidden=false;
}
if(el('wcCopy'))el('wcCopy').onclick=async()=>{
 const uri=pairingUri;
 if(!uri)return;
 try{
   await navigator.clipboard.writeText(uri);
   if(pairingUri===uri)el('wcCopy').textContent=wcText[lang].copied;
 }catch{
   if(pairingUri!==uri || !el('wcManual'))return;
   el('wcManual').hidden=false;
   const field=el('wcLink');
   field.value=uri;
   field.focus();
   field.select();
 }
};
dialog.addEventListener('close',()=>{closePairing();render();});
// GemWallet 3.8.2 resolves a request before its popup finishes closing.
// Queue prompts so the close event cannot reject the following wallet request.
let gemReady=Promise.resolve();
function gemPrompt(open) {
 const result=gemReady.then(open);
 const settle=()=>new Promise(resolve=>setTimeout(resolve,500));
 gemReady=result.then(settle,settle);
 return result;
}
const text=i=>copy[lang][i];
const objKey=()=> 'coolbears.xrpl.order.'+status.network;
const txKey=()=> 'coolbears.xrpl.pending.'+status.network;
const mintPilot=()=>status?.network==='Testnet' && ['single-slot','collection'].includes(status.mintMode) && (location.hostname==='127.0.0.1' || (status.mintMode==='collection' && location.origin==='https://testnet.coolbears-nfts.com'));
const testMintCopy={
 en:{mintText:'On Testnet you can buy one NFT at a time.',mintFeeNote:'Each NFT costs 10 test XRP plus the Testnet transaction fee.',button:'Mint · 10 test XRP'},
 ru:{mintText:'В тестовой сети можно купить один NFT за раз.',mintFeeNote:'Один NFT стоит 10 тестовых XRP плюс комиссия тестовой сети.',button:'Минт · 10 тестовых XRP'},
 zh:{mintText:'在测试网上每次可购买 1 个 NFT。',mintFeeNote:'每个 NFT 的价格为 10 测试 XRP，另加测试网交易费。',button:'铸造 · 10 测试 XRP'}
};
const quantity=()=>Math.max(1,Math.min(mintPilot()?1:50,Math.floor(Number(el('qty').value)||1)));
function salesLabel(){
 if(status?.serviceState==='network-unavailable')
   return {en:'Testnet temporarily unavailable',ru:'Тестовая сеть временно недоступна',zh:'测试网暂时不可用'}[lang];
 if(status?.serviceState==='collection-unavailable')
   return {en:'Test collection temporarily unavailable',ru:'Тестовая коллекция временно недоступна',zh:'测试系列暂时不可用'}[lang];
 return text(0);
}
function render(){
 const q=quantity();el('qty').value=q;el('total').textContent=q*10;
 const wcButton=el('wcWallet');
 if(wcButton){
   wcButton.disabled=!status?.walletConnectProjectId || !!pairing;
   wcButton.textContent='WalletConnect · Joey / Bifrost'+(status&&!status.walletConnectProjectId?' · '+wcText[lang].soon:'');
   const words=wcText[lang];
   const bifrostTestnet={en:'Use testnet mode in Bifrost.',ru:'Для Bifrost включите тестовый режим.',zh:'请在 Bifrost 中启用测试网模式。'};
   el('wcHint').textContent=words.hint+(status?.network==='Testnet'?' '+bifrostTestnet[lang]:'');
   el('wcOpen').textContent=words.open+' Bifrost';
   if(el('wcJoey'))el('wcJoey').textContent=words.open+' Joey';
   if(el('wcManualLabel'))el('wcManualLabel').textContent=words.manual;
 }
 const xamanButton=el('xamanWallet'), resume=el('xamanResume');
 xamanButton.disabled=!status?.xamanClientId;
 xamanButton.textContent=xamanButton.disabled?{en:'Xaman · coming soon',ru:'Xaman · скоро',zh:'Xaman · 即将开放'}[lang]:'Xaman';
 const link=xaman.signingUrl(pending?.xaman?.id,pending?.xaman?.url);
 resume.hidden=!link || !!pending?.hash;
 if(link){resume.href=link;resume.textContent={en:'Open Xaman',ru:'Открыть Xaman',zh:'打开 Xaman'}[lang];}
 else resume.removeAttribute('href');
 el('walletBtn').textContent=account?account.slice(0,6)+'…'+account.slice(-4):text(3);
 buy.disabled=busy || !status || (!status.open && !pending);
 buy.textContent=pending?text(2):!status?text(8):!status.open?salesLabel():
   mintPilot()?testMintCopy[lang].button:order && order.done>0?text(7)+' · 10 XRP':text(1)+' '+q*10+(status.network==='Testnet'?' test XRP':' XRP');
 el('minted').textContent=status?status.network+' · '+(status.open?(status.network==='Testnet'?'TEST XRP':'XRP'):salesLabel()):'';
 el('qty').disabled=busy||!!pending||!!order||mintPilot();el('minus').disabled=el('qty').disabled||q<=1;el('plus').disabled=el('qty').disabled||q>=50;
}
function language(){
 document.documentElement.lang=lang;
 updateRarityLanguage?.(lang);
 const overrides=mintPilot()?testMintCopy[lang]:{};
 for(const node of document.querySelectorAll('[data-i18n]')){
   const key=node.dataset.i18n;
   const value=overrides[key] ?? translations[lang][key];if(!value)continue;
   node.replaceChildren();
   value.split(/<br\s*\/?>/i).forEach((part,i)=>{if(i)node.append(document.createElement('br'));node.append(document.createTextNode(part));});
 }
 document.querySelectorAll('[data-lang]').forEach(x=>x.classList.toggle('active',x.dataset.lang===lang));
 if(rankingVisible)document.querySelector('[data-i18n=top50Text]').textContent=rankingText();
 el('walletTitle').textContent=text(3);render();
}
document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{lang=b.dataset.lang;storage.set('coolbears.xrpl.language',lang);language();});
el('minus').onclick=()=>{el('qty').value=quantity()-1;render()};el('plus').onclick=()=>{el('qty').value=quantity()+1;render()};
el('qty').onchange=render;el('backTop').onclick=()=>scrollTo({top:0,behavior:'smooth'});
addEventListener('scroll',()=>el('backTop').classList.toggle('show',scrollY>400),{passive:true});
async function api(name,params={},signal){
 const url=new URL('/xrpl/api/'+name,location.origin);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
 const r=await fetch(url,{cache:'no-store',signal}),data=await r.json();
 if(!r.ok&&!data.state)throw Error(data.error||text(8));return data;
}
function requestKey(buyer){return 'coolbears.xrpl.collection.request.'+status.issuer+'.'+buyer}
async function collectionRequest(buyer,resuming=false){
 if(!['gem','cross','xaman','wc'].includes(wallet))throw Error(text(8));
 const key=requestKey(buyer);
 let id=storage.get(key);
 if(!id){id=crypto.randomUUID();storage.set(key,id);}
 const send=async(path,data,bearer)=>{
   const tries=path==='mint'?36:1;
   for(let i=0;i<tries;i++){
     let r;
     try{r=await fetch('/xrpl/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+bearer}:{})},body:JSON.stringify(data)})}
     catch(e){if(i+1>=tries)throw e;}
     const v=r ? await r.json().catch(()=>({})) : {};
     if(r?.status===503 && v.state==='maintenance'){
       status.open=false;status.serviceState=v.serviceState;render();throw Error(salesLabel());
     }
     if((!r||[502,503,504].includes(r.status))&&i+1<tries){
       await new Promise(resolve=>setTimeout(resolve,900));continue;
     }
     if(r.status===202 && v.state==='preparing'){
       message.textContent={en:'Preparing your NFT on Testnet…',ru:'Выпускаем ваш NFT в тестовой сети…',zh:'正在测试网准备您的 NFT…'}[lang];
       if(i+1===tries)throw Error(text(5));
       await new Promise(resolve=>setTimeout(resolve,1800));continue;
     }
     if(!r.ok){if(v.state==='expired')storage.set(key,null);throw Error(v.error||text(8))}
     return v;
   }
 };
 const isXaman=wallet==='xaman';
 const user=isXaman?xaman.session(status):null;
 if(isXaman && (!user || user.account!==buyer))throw Error('Xaman · '+text(3));
 const identity={buyer,request:id,...(isXaman?{provider:'xaman'}:wallet==='wc'?{provider:'walletconnect'}:{})};
 const proof=await send('challenge',identity,user?.token);
 let pk,signature;
 if(wallet==='wc'){
   message.textContent={en:'Open your wallet to sign the reservation. This step costs no XRP.',
     ru:'Откройте кошелёк и подпишите бронь. На этом шаге XRP не списываются.',
     zh:'请打开钱包签署预订。本步骤无需支付 XRP。'}[lang];
   pk=await wc.signReservation(status.network,buyer,proof.message);signature=pk.signature;
 }else if(wallet==='gem'){
   pk=(await gemPrompt(()=>window.GemWalletApi.getPublicKey())).result;
   if(pk?.address!==buyer)throw Error(text(4)+' Testnet');
   signature=(await gemPrompt(()=>window.GemWalletApi.signMessage(proof.message))).result?.signedMessage;
 }else if(wallet==='cross'){
   const bytes=new TextEncoder().encode(proof.message);
   const hex=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
   pk=(await window.CoolBearsCrossmark.methods.signInAndWait(hex))?.response?.data;
   if(pk?.address!==buyer || pk.network?.type?.toLowerCase()!=='testnet' || pk.network?.protocol!=='XRPL')throw Error(text(4)+' Testnet');
   signature=pk.signature;
 }
 if(!isXaman && !signature)throw Error(text(10));
 const reply=await send('mint',{...identity,expires:proof.expires,nonce:proof.nonce,tag:proof.tag,
   ...(isXaman?{}:{publicKey:pk.publicKey,signature})});
 if(reply.state==='resume'){
   if(resuming || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reply.request))throw Error(text(8));
   storage.set(key,reply.request);return collectionRequest(buyer,true);
 }
 return reply;
}
async function selectOffer(buyer){
 let offer;
 if(mintPilot() && status.mintMode==='collection'){
   const result=await collectionRequest(buyer);
   if(!/^[A-F0-9]{64}$/.test(result.id))throw Error(text(8));
   if(result.state==='sold'){
     if(!/^[A-F0-9]{64}$/.test(result.hash))throw Error(text(8));
     pending={offer:result.id,buyer,hash:result.hash,network:status.network};storage.set(txKey(),pending);
     await check();return null;
   }
   offer=result.id;
 }else if(mintPilot()){
   const reply=await fetch('/xrpl/api/mint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer})});
   const result=await reply.json();
   if(!reply.ok)throw Error(result.error||text(8));
   offer=result.id;
 }else{
   offer=(await api('offer',{buyer})).id;
 }
 if(!/^[A-F0-9]{64}$/.test(offer))throw Error(text(8));
 return api('offer',{buyer,offer});
}
async function connect(kind) {
 if(!status)throw Error(text(8));
 if(kind==='wc'){
   if(!status.walletConnectProjectId)throw Error('WalletConnect · '+text(8));
   closePairing();const attempt=new AbortController();pairing=attempt;render();
   try{account=await wc.connect(status.walletConnectProjectId,status.network,showPairing,attempt.signal);}
   finally{if(pairing===attempt){closePairing();render();}}
 }else if(kind==='xaman'){
   if(!status.xamanClientId)throw Error('Xaman · '+text(8));
   const session=xaman.session(status);
   if(!session){await xaman.authorize(status);return false;}
   account=session.account;
 }else if(kind==='gem'){
   const sdk=window.GemWalletApi;
   if(!(await sdk?.isInstalled())?.result?.isInstalled)throw Error('GemWallet · '+text(8));
   const net=(await gemPrompt(()=>sdk.getNetwork())).result;
   if(net?.chain!=='XRPL'||net.network.toLowerCase()!==status.network.toLowerCase())throw Error(text(4)+' XRPL '+status.network);
   account=(await gemPrompt(()=>sdk.getAddress())).result?.address;
 }else{
   const sdk=window.CoolBearsCrossmark;
   if(!sdk?.methods?.isInstalled())throw Error('CROSSMARK · '+text(8));
   const session=wallet===kind && sdk.methods.getAddress();
   const res=session?null:await sdk.methods.signInAndWait();
   const net=sdk.methods.getNetwork() || res?.response?.data?.network;
   if(!net || String(net.type).toLowerCase()!==status.network.toLowerCase() ||
      net.protocol!=='XRPL' || String(net.label).toLowerCase()!=='xrp ledger')throw Error(text(4)+' XRPL '+status.network);
   account=sdk.methods.getAddress() || res?.response?.data?.address;
 }
 if(!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account||''))throw Error(text(8));
 wallet=kind;storage.set('coolbears.xrpl.wallet',kind);dialog.close();render();return true;
}
function pick(){el('walletInfo').textContent='';if(!dialog.open)dialog.showModal();}
el('walletBtn').onclick=()=>{if(!busy)pick()};el('closeWallet').onclick=()=>dialog.close();
document.querySelectorAll('[data-wallet]').forEach(b=>b.onclick=async()=>{try{closePairing();render();await connect(b.dataset.wallet)}catch(e){if(e.name!=='AbortError')el('walletInfo').textContent=e.message}});
let checkingReceipt, receiptTimer, watchingReceipt=false, receiptDelay=4000;
function backgroundReceipt(){
 if(!pending || document.hidden)return;
 check().catch(error=>{message.textContent=error.message;});
}
function check(){
 if(checkingReceipt)return checkingReceipt;
 clearTimeout(receiptTimer);
 watchingReceipt=true;
 checkingReceipt=readReceipt().finally(()=>{
   checkingReceipt=null;
   if(pending && !document.hidden){
     receiptTimer=setTimeout(backgroundReceipt,receiptDelay);
     receiptDelay=Math.min(receiptDelay*2,30000);
   }
   if(!pending){receiptDelay=4000;watchingReceipt=false;receiptTimer=null;}
   render();
 });
 return checkingReceipt;
}
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden && pending && !busy && watchingReceipt)backgroundReceipt();
});
async function readReceipt(){
 if(pending.xaman && !pending.hash){
   // A ledger lookup also recovers a signed transaction if the provider session expired.
   const result=await xaman.signatureResult(status,pending).catch(()=>null);
   if(result?.declined){
     pending=null;storage.set(txKey(),null);
     if(!order?.done){order=null;storage.set(objKey(),null);}
     message.textContent=text(10);return;
   }
   if(result?.hash){pending.hash=result.hash;storage.set(txKey(),pending);}
 }
 const {buyer,offer,last,hash}=pending;
 const search={buyer,offer,...(last?{last}:{})};
 let r=await api(hash?'receipt':'reconcile',hash?{...search,hash}:search);
 if(r.state==='mismatch' && hash && last)r=await api('reconcile',search);
 if(r.state==='pending'){message.textContent=text(5);return;}
 if(r.state==='complete'){
   const id=r.hash;const explorer=status.network==='Testnet'?'testnet.xrpl.org':'livenet.xrpl.org';
   if(mintPilot()&&status.mintMode==='collection')storage.set(requestKey(pending.buyer),null);
   receipt.href='https://'+explorer+'/transactions/'+id;receipt.hidden=false;
   if(order && order.lastHash!==id){order.done++;order.lastHash=id;storage.set(objKey(),order);}
   message.textContent=text(6)+(order?' '+order.done+' / '+order.target:'');
   if(order && order.done>=order.target){order=null;storage.set(objKey(),null);}
 }else if(r.state==='expired'||r.state==='failed'){message.textContent=text(10);order=null;storage.set(objKey(),null);}
 else{message.textContent=text(8);return;}
 pending=null;storage.set(txKey(),null);
}
buy.onclick=async()=>{
 if(busy||buy.disabled)return;busy=true;render();
 try{
   if(pending){await check();return;}
   if(!wallet||!account){pick();return;}
   const buyer=account;if(!await connect(wallet))return;if(account!==buyer)throw Error(text(4)+' '+status.network);
   if(order && buyer!==order.buyer)throw Error('Select the wallet for this order.');
   const q=await selectOffer(buyer);if(!q)return;
   if(q.price!=='10000000'||!/^[A-F0-9]{64}$/.test(q.id))throw Error(text(8));
   receipt.hidden=true;receipt.removeAttribute('href');
   if(!order){order={buyer,target:quantity(),done:0};storage.set(objKey(),order);}
   pending={offer:q.id,buyer,last:q.validThrough,network:status.network};storage.set(txKey(),pending);
   let hash;
   if(wallet==='xaman'){
     let signature;
     try{signature=await xaman.createOfferSignature(status,pending);}
     catch(e){
       // No signing link was offered to the buyer.
       pending=null;storage.set(txKey(),null);
       if(!order.done){order=null;storage.set(objKey(),null);}
       throw e;
     }
     pending.xaman=signature;storage.set(txKey(),pending);location.assign(signature.url);return;
   }
   if(wallet==='wc'){
     message.textContent={en:'Confirm the NFT purchase in your wallet.',ru:'Подтвердите покупку NFT в кошельке.',zh:'请在钱包中确认购买 NFT。'}[lang];
     try{hash=await wc.acceptOffer(status.network,buyer,q);}
     catch(e){
       if([4001,5000].includes(e?.code)){
         pending=null;storage.set(txKey(),null);
         if(!order.done){order=null;storage.set(objKey(),null);}throw Error(text(10));
       }
       throw e;
     }
   }else if(wallet==='gem'){hash=(await gemPrompt(()=>window.GemWalletApi.acceptNFTOffer({NFTokenSellOffer:q.id,lastLedgerSequence:q.validThrough}))).result?.hash;}
   else{
     const reply=await window.CoolBearsCrossmark.methods.signAndSubmitAndWait({TransactionType:'NFTokenAcceptOffer',Account:buyer,NFTokenSellOffer:q.id,LastLedgerSequence:q.validThrough});
     hash=reply.response?.data?.resp?.result?.hash || reply.response?.data?.resp?.result?.tx_json?.hash;
   }
   if(hash && /^[a-f\d]{64}$/i.test(hash)){pending.hash=hash.toUpperCase();storage.set(txKey(),pending);}
   await check();
 }catch(e){message.textContent=e.message;}finally{
   busy=false;render();
   if(pending && !watchingReceipt && !pending.xaman?.id)backgroundReceipt();
 }
};
const rankingText=()=>({en:'Ranked by final rarity score.',ru:'Места по итоговой оценке редкости.',zh:'按最终稀有度评分排名。'}[lang]);
async function loadRanking(){
 try{
   const data=await api('top50');
   if(!data.revealed){setTimeout(loadRanking,60000);return;}
   if(!Array.isArray(data.rows)||data.rows.length!==50)throw Error('Incomplete ranking');
   const list=document.createElement('ol');
   for(const [index,row] of data.rows.entries()){
     if(row.rank!==index+1||!/^\d{4}$/.test(row.slot))throw Error('Invalid ranking');
     const item=document.createElement('li'), link=document.createElement('a');
     link.href='/xrpl/?slot='+row.slot+'#rarity';link.textContent=row.name;
     item.append(link,document.createTextNode(' · '+row.score));list.append(item);
   }
   const details=document.createElement('details'), summary=document.createElement('summary');
   summary.textContent='TOP 50';details.append(summary,list);
   document.querySelector('.top50-stamp').replaceWith(details);
   updateRarityLanguage=mountRarity(el('rarity'),lang);
   rankingVisible=true;document.querySelector('[data-i18n=top50Text]').textContent=rankingText();
 }catch{setTimeout(loadRanking,60000);}
}
function scheduleRanking(){
 const delay=Date.parse(status.revealAt)-status.serverTime;
 if(!Number.isFinite(delay))return;
 // Long-running tabs must also wake up on the reveal date.
 const due=performance.now()+Math.max(0,delay);
 function wake(){const remaining=due-performance.now();if(remaining<=0)loadRanking();else setTimeout(wake,Math.min(remaining,2147480000));}
 wake();
}
async function loadStatus(){
 let delay=2000;
 for(;;){
   try{
     const info=await api('status',{},globalThis.AbortSignal?.timeout?.(30000));
     if(!['Testnet','Mainnet'].includes(info.network) || typeof info.open!=='boolean')throw Error();
     message.textContent='';
     return info;
   }catch{
     message.textContent={en:'Reconnecting to the site…',ru:'Восстанавливаем связь с сайтом…',zh:'正在重新连接网站…'}[lang];
     await new Promise(resolve=>setTimeout(resolve,delay));
     delay=Math.min(delay*2,30000);
   }
 }
}
language();
status=await loadStatus();
pending=storage.get(txKey());
order=storage.get(objKey());
if(order)el('qty').value=order.target;
language();scheduleRanking();
if(status.xamanClientId){
 try{
   const login=await xaman.finishLogin(status);
   const user=login || (storage.get('coolbears.xrpl.wallet')==='xaman' && xaman.session(status));
   if(user){wallet='xaman';account=user.account;storage.set('coolbears.xrpl.wallet',wallet);if(login&&!pending)location.hash='mint';}
 }catch(e){message.textContent=e.message;}
}
if(pending)await check().catch(e=>{message.textContent=e.message;});
render();
