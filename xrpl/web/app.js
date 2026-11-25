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
let status,account,wallet,busy=false,pending,order;
const text=i=>copy[lang][i];
const objKey=()=> 'coolbears.xrpl.order.'+status.network;
const txKey=()=> 'coolbears.xrpl.pending.'+status.network;
const quantity=()=>Math.max(1,Math.min(50,Math.floor(Number(el('qty').value)||1)));
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
   order && order.done>0?text(7)+' · 10 XRP':text(1)+' '+q*10+(status.network==='Testnet'?' test XRP':' XRP');
 el('minted').textContent=status?status.network+' · '+(status.open?(status.network==='Testnet'?'TEST XRP':'XRP'):text(0)):'';
 el('qty').disabled=busy||!!pending||!!order;el('minus').disabled=el('qty').disabled||q<=1;el('plus').disabled=el('qty').disabled||q>=50;
}
function language(){
 document.documentElement.lang=lang;
 for(const node of document.querySelectorAll('[data-i18n]')){
   const value=translations[lang][node.dataset.i18n];if(!value)continue;
   node.replaceChildren();
   value.split(/<br\s*\/?>/i).forEach((part,i)=>{if(i)node.append(document.createElement('br'));node.append(document.createTextNode(part));});
 }
 document.querySelectorAll('[data-lang]').forEach(x=>x.classList.toggle('active',x.dataset.lang===lang));
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
   let q=await api('offer',{buyer});q=await api('offer',{buyer,offer:q.id});
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
language();
try{status=await api('status');pending=storage.get(txKey());order=storage.get(objKey());if(order)el('qty').value=order.target;
 if(status.xamanClientId){
   const login=await xaman.finishLogin(status);
   const user=login || (storage.get('coolbears.xrpl.wallet')==='xaman' && xaman.session(status));
   if(user){wallet='xaman';account=user.account;storage.set('coolbears.xrpl.wallet',wallet);if(login&&!pending)location.hash='mint';}
 }
 if(pending)await check();}
catch(e){message.textContent=e.message;}render();
