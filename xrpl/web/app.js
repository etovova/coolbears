const buy=document.querySelector('#buy'), message=document.querySelector('#message'), receipt=document.querySelector('#receipt');
const key='coolbears.xrpl.pending.v1';
let status, pending;
const dictionary={
  en:{tagline:'Everyone gets a bear. Not everyone gets a legend.',collection:'Collection',price:'Mint price',reveal:'Reveal',terms:'Terms',privacy:'Privacy',closed:'Sales closed',test:'Buy for 10 test XRP',buy:'Buy for 10 XRP',check:'Check transaction',unavailable:'Unavailable',view:'View transaction',disclaimer:'No real value. No financial returns. No celebrity backing. Don’t buy expecting profit. CoolBears is just for fun.'},
  ru:{tagline:'Каждому достанется медведь. Легенда достанется не каждому.',collection:'Коллекция',price:'Цена минта',reveal:'Раскрытие',terms:'Условия',privacy:'Конфиденциальность',closed:'Продажи закрыты',test:'Купить за 10 тестовых XRP',buy:'Купить за 10 XRP',check:'Проверить транзакцию',unavailable:'Недоступно',view:'Посмотреть транзакцию',disclaimer:'CoolBears — коллекция для развлечения. Финансовая доходность не обещается. Не покупайте в расчёте на прибыль.'},
  zh:{tagline:'每个人都能得到一只熊，但不是每个人都能得到传奇。',collection:'藏品总量',price:'铸造价格',reveal:'揭晓时间',terms:'条款',privacy:'隐私',closed:'暂未开售',test:'用 10 个测试 XRP 购买',buy:'用 10 XRP 购买',check:'查看交易',unavailable:'暂不可用',view:'查看交易详情',disclaimer:'CoolBears 仅供娱乐，不保证收益。请勿以获利为目的购买。'}
};
const selector=document.querySelector('#language');
selector.value=localStorage.getItem('coolbears.language') || (dictionary[navigator.language.slice(0,2)]?navigator.language.slice(0,2):'en');
const strings=()=>dictionary[selector.value]||dictionary.en;
function language(){
 const t=strings();
 document.documentElement.lang=selector.value;
 for(const item of document.querySelectorAll('[data-t]'))item.textContent=t[item.dataset.t];
 document.querySelector('time').textContent=new Intl.DateTimeFormat(selector.value,{dateStyle:'long',timeStyle:'short',timeZone:'UTC'}).format(new Date('2027-02-01T00:00:00Z'))+' UTC';
 receipt.textContent=t.view;render();
}
selector.addEventListener('change',()=>{localStorage.setItem('coolbears.language',selector.value);language();});
function setText(text){ message.textContent=text; }
async function call(path,params={}){
  const url=new URL('/xrpl/api/'+path,location.origin);
  for(const [name,value] of Object.entries(params)) url.searchParams.set(name,value);
  const response=await fetch(url,{cache:'no-store'}), data=await response.json();
  if (!response.ok && !data.state) throw Error(data.error || 'Service unavailable');
  return data;
}
function render(){
  buy.disabled=!status || (!pending && !status.open);
  const t=strings();
  buy.textContent=pending?t.check:!status?t.unavailable:!status.open?t.closed:status.network==='Testnet'?t.test:t.buy;
}
async function check(){
  const result=await call(pending.hash?'receipt':'reconcile',pending);
  if(result.state==='pending'){setText('Waiting for ledger confirmation. You can check again.');return;}
  if(result.state==='complete'){
    setText('Purchase confirmed. The CoolBear is in your wallet.');
    const host=status.network==='Testnet'?'testnet.xrpl.org':'livenet.xrpl.org';
    receipt.href='https://'+host+'/transactions/'+result.hash;receipt.hidden=false;
  } else if(result.state==='expired'){setText('The signing window expired. No matching purchase was found.');}
  else if(result.state==='failed'){setText('The ledger declined this purchase. '+result.result);}
  else {setText('This transaction does not match this purchase. Check your wallet history.');return;}
  pending=null; localStorage.removeItem(key);
}
async function walletAccount(){
  const wallet=window.GemWalletApi;
  if(!wallet || !(await wallet.isInstalled())?.result?.isInstalled) throw Error('Open this page in a browser with the GemWallet extension.');
  const net=(await wallet.getNetwork()).result;
  if(net?.chain!=='XRPL' || net.network.toLowerCase()!==status.network.toLowerCase()) throw Error('Select XRPL '+status.network+' in GemWallet.');
  const address=(await wallet.getAddress()).result?.address;
  if(!address) throw Error('Wallet connection cancelled.');
  return address;
}
buy.addEventListener('click',async()=>{
  if(buy.disabled)return;
  buy.disabled=true;receipt.hidden=true;
  try{
    if(pending){await check();return;}
    const buyer=await walletAccount();
    setText('Checking a 10 XRP sell offer on the ledger…');
    let quote=await call('offer',{buyer});
    quote=await call('offer',{buyer,offer:quote.id});
    if(quote.price!=='10000000' || !/^[A-F0-9]{64}$/.test(quote.id)) throw Error('Invalid sell offer.');
    if(await walletAccount()!==buyer) throw Error('Wallet account changed. Please try again.');
    setText('Confirm the 10 XRP purchase in GemWallet.');
    pending={buyer,offer:quote.id,last:quote.validThrough,network:status.network};
    localStorage.setItem(key,JSON.stringify(pending));
    const signed=await window.GemWalletApi.acceptNFTOffer({NFTokenSellOffer:quote.id,lastLedgerSequence:quote.validThrough});
    if(!signed.result?.hash){setText('Wallet returned no transaction hash. Check your wallet before retrying.');return;}
    pending.hash=signed.result.hash.toUpperCase();
    localStorage.setItem(key,JSON.stringify(pending));
    await check();
  } catch(error){setText(error.message || 'Service unavailable.');}
  finally{render();}
});
language();
try{
  status=await call('status');
  document.querySelector('#network').textContent='XRP Ledger · '+status.network;
  const saved=JSON.parse(localStorage.getItem(key) || 'null');
  if(saved?.network===status.network){pending=saved;await check();}
} catch(error){setText(error.message);}
render();
