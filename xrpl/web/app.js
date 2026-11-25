import {mountRarity} from './rarity.mjs';
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
let updateRarityLanguage;
const text=i=>copy[lang][i];
const objKey=()=> 'coolbears.xrpl.order.'+status.network;
const txKey=()=> 'coolbears.xrpl.pending.'+status.network;
const mintPilot=()=>status?.network==='Testnet' && ['single-slot','collection'].includes(status.mintMode) && (location.hostname==='127.0.0.1' || (status.mintMode==='collection' && location.origin==='https://testnet.coolbears-nfts.com'));
const quantity=()=>Math.max(1,Math.min(mintPilot()?1:50,Math.floor(Number(el('qty').value)||1)));
function render(){
 const q=quantity();el('qty').value=q;el('total').textContent=q*10;
 const xamanButton=el('xamanWallet'), resume=el('xamanResume');
 xamanButton.disabled=!status?.xamanClientId;
 xamanButton.textContent=xamanButton.disabled?{en:'Xaman · coming soon',ru:'Xaman · скоро',zh:'Xaman · 即将开放'}[lang]:'Xaman';
 const link=xaman.signingUrl(pending?.xaman?.id,pending?.xaman?.url);
 resume.hidden=!link || !!pending?.hash;
 if(link){resume.href=link;resume.textContent={en:'Open Xaman',ru:'Открыть Xaman',zh:'打开 Xaman'}[lang];}
 else resume.removeAttribute('href');
 el('walletBtn').textContent=account?account.slice(0,6)+'…'+account.slice(-4):text(3);
 buy.disabled=busy || !status || (!status.open && !pending);
 buy.textContent=pending?text(2):!status?text(8):!status.open?text(0):
   mintPilot()?'Mint · 10 test XRP':order && order.done>0?text(7)+' · 10 XRP':text(1)+' '+q*10+(status.network==='Testnet'?' test XRP':' XRP');
 el('minted').textContent=status?status.network+' · '+(status.open?(status.network==='Testnet'?'TEST XRP':'XRP'):text(0)):'';
 el('qty').disabled=busy||!!pending||!!order||mintPilot();el('minus').disabled=el('qty').disabled||q<=1;el('plus').disabled=el('qty').disabled||q>=50;
}
function language(){
 document.documentElement.lang=lang;
 updateRarityLanguage?.(lang);
 for(const node of document.querySelectorAll('[data-i18n]')){
   const value=translations[lang][node.dataset.i18n];if(!value)continue;
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
async function api(name,params={}){
 const url=new URL('/xrpl/api/'+name,location.origin);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
 const r=await fetch(url,{cache:'no-store'}),data=await r.json();
 if(!r.ok&&!data.state)throw Error(data.error||text(8));return data;
}
function requestKey(buyer){return 'coolbears.xrpl.collection.request.'+status.issuer+'.'+buyer}
async function collectionRequest(buyer,resuming=false){
 if(!['gem','cross'].includes(wallet))throw Error(text(8));
 const key=requestKey(buyer);
 let id=storage.get(key);
 if(!id){id=crypto.randomUUID();storage.set(key,id);}
 const send=async(path,data)=>{
   const tries=path==='mint'?36:1;
   for(let i=0;i<tries;i++){
     let r;
     try{r=await fetch('/xrpl/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})}
     catch(e){if(i+1>=tries)throw e;}
     if((!r||[502,503,504].includes(r.status))&&i+1<tries){
       await new Promise(resolve=>setTimeout(resolve,900));continue;
     }
     const v=await r.json();
     if(r.status===202 && v.state==='preparing'){
       message.textContent={en:'Preparing your NFT on Testnet…',ru:'Выпускаем ваш NFT в тестовой сети…',zh:'正在测试网准备您的 NFT…'}[lang];
       if(i+1===tries)throw Error(text(5));
       await new Promise(resolve=>setTimeout(resolve,1800));continue;
     }
     if(!r.ok){if(v.state==='expired')storage.set(key,null);throw Error(v.error||text(8))}
     return v;
   }
 };
 const proof=await send('challenge',{buyer,request:id});
 let pk,signature;
 if(wallet==='gem'){
   pk=(await window.GemWalletApi.getPublicKey()).result;
   if(pk?.address!==buyer)throw Error(text(4)+' Testnet');
   signature=(await window.GemWalletApi.signMessage(proof.message)).result?.signedMessage;
 }else{
   const bytes=new TextEncoder().encode(proof.message);
   const hex=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
   pk=(await window.CoolBearsCrossmark.methods.signInAndWait(hex))?.response?.data;
   if(pk?.address!==buyer || pk.network?.type?.toLowerCase()!=='testnet' || pk.network?.protocol!=='XRPL')throw Error(text(4)+' Testnet');
   signature=pk.signature;
 }
 if(!signature)throw Error(text(10));
 const reply=await send('mint',{buyer,request:id,expires:proof.expires,nonce:proof.nonce,tag:proof.tag,publicKey:pk.publicKey,signature});
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
 if(kind==='xaman'){
   if(!status.xamanClientId)throw Error('Xaman · '+text(8));
   const session=xaman.session(status);
   if(!session){await xaman.authorize(status);return false;}
   account=session.account;
 }else if(kind==='gem'){
   const sdk=window.GemWalletApi;
   if(!(await sdk?.isInstalled())?.result?.isInstalled)throw Error('GemWallet · '+text(8));
   const net=(await sdk.getNetwork()).result;
   if(net?.chain!=='XRPL'||net.network.toLowerCase()!==status.network.toLowerCase())throw Error(text(4)+' XRPL '+status.network);
   account=(await sdk.getAddress()).result?.address;
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
el('walletBtn').onclick=pick;el('closeWallet').onclick=()=>dialog.close();
document.querySelectorAll('[data-wallet]').forEach(b=>b.onclick=async()=>{try{await connect(b.dataset.wallet)}catch(e){el('walletInfo').textContent=e.message}});
async function check(){
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
 const r=await api(pending.hash?'receipt':'reconcile',pending);
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
   if(wallet==='gem'){hash=(await window.GemWalletApi.acceptNFTOffer({NFTokenSellOffer:q.id,lastLedgerSequence:q.validThrough})).result?.hash;}
   else{
     const reply=await window.CoolBearsCrossmark.methods.signAndSubmitAndWait({TransactionType:'NFTokenAcceptOffer',Account:buyer,NFTokenSellOffer:q.id,LastLedgerSequence:q.validThrough});
     hash=reply.response?.data?.resp?.result?.hash || reply.response?.data?.resp?.result?.tx_json?.hash;
   }
   if(hash && /^[a-f\d]{64}$/i.test(hash)){pending.hash=hash.toUpperCase();storage.set(txKey(),pending);}
   await check();
 }catch(e){message.textContent=e.message;}finally{busy=false;render();}
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
language();
try{status=await api('status');scheduleRanking();pending=storage.get(txKey());order=storage.get(objKey());if(order)el('qty').value=order.target;
 if(status.xamanClientId){
   const login=await xaman.finishLogin(status);
   const user=login || (storage.get('coolbears.xrpl.wallet')==='xaman' && xaman.session(status));
   if(user){wallet='xaman';account=user.account;storage.set('coolbears.xrpl.wallet',wallet);if(login&&!pending)location.hash='mint';}
 }
 if(pending)await check();}
catch(e){message.textContent=e.message;}render();
