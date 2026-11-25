const buy=document.querySelector('#buy'), message=document.querySelector('#message'), receipt=document.querySelector('#receipt');
const key='coolbears.xrpl.pending.v1';
let status, pending;
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
  buy.textContent=pending?'Check transaction':!status?'Unavailable':!status.open?'Sales closed':
    status.network==='Testnet'?'Buy for 10 test XRP':'Buy for 10 XRP';
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
try{
  status=await call('status');
  document.querySelector('#network').textContent='XRP Ledger · '+status.network;
  const saved=JSON.parse(localStorage.getItem(key) || 'null');
  if(saved?.network===status.network){pending=saved;await check();}
} catch(error){setText(error.message);}
render();
