import {reservationEnvelope} from './reservation-envelope.mjs';
const method = 'xrpl_signTransaction';
const networks = {Mainnet:'xrpl:0', Testnet:'xrpl:1'};
const address = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function sessionBuyer(session, network) {
  const chain = networks[network];
  if (!chain || !(session?.expiry > Date.now()/1000)) return null;
  const ns = session.namespaces?.xrpl ?? session.namespaces?.[chain];
  if (!ns?.methods?.includes(method)) return null;
  const prefix = chain + ':';
  return ns.accounts?.filter(id => id.startsWith(prefix)).map(id=>id.slice(prefix.length)).find(id=>address.test(id)) || null;
}

export function walletAdapter({loadSdk = () => import('/xrpl/walletconnect-sdk.mjs'), origin, onChange}) {
  let sdk, clientPromise, current;
  async function clientFor(projectId) {
    if (!/^[a-f0-9]{32}$/i.test(projectId || '')) throw Error('WalletConnect · Project ID');
    if (!clientPromise) clientPromise = (async () => {
      sdk = await loadSdk();
      const client = await sdk.SignClient.init({projectId, logger:'error', telemetryEnabled:false,
        metadata:{name:'CoolBears',description:'CoolBears NFTs on XRP Ledger',url:origin,icons:[origin+'/xrpl/brand-logo.png']}});
      client.on('session_update',({topic,params})=>{
        if (current?.topic===topic) onChange(sessionBuyer({...client.session.get(topic),namespaces:params.namespaces},current.network));
      });
      const removed = ({topic})=>{
        if (current?.topic===topic) {current=null;onChange(null);}
      };
      client.on('session_delete',removed);client.on('session_expire',removed);
      return client;
    })().catch(error=>{clientPromise=null;throw error;});
    return clientPromise;
  }
  async function connect(projectId, network, show, signal) {
    const client = await clientFor(projectId);
    signal.throwIfAborted();
    let session = client.session.getAll().find(item=>sessionBuyer(item,network));
    if (!session) {
      const chain=networks[network];
      if (!chain) throw Error('WalletConnect · XRPL network');
      const {uri,approval}=await client.connect({requiredNamespaces:{xrpl:{chains:[chain],methods:[method],events:[]}}});
      const approved=approval();
      approved.catch(()=>{});
      signal.throwIfAborted();
      if (uri) {
        if (!uri.startsWith('wc:')) throw Error('WalletConnect · invalid pairing URI');
        const image=await sdk.qr.toDataURL(uri,{width:256,margin:4});
        signal.throwIfAborted();show(uri,image);
      }
      session=await approved;
    }
    signal.throwIfAborted();
    const buyer=sessionBuyer(session,network);
    if (!buyer) throw Error('WalletConnect · XRPL '+network);
    current={topic:session.topic,network};
    return buyer;
  }
  async function request(network, buyer, tx, submit) {
    const client=await clientPromise;
    if (!current || current.network!==network || sessionBuyer(client.session.get(current.topic),network)!==buyer)
      throw Error('WalletConnect · XRPL '+network);
    const reply=await client.request({topic:current.topic,chainId:networks[network],
      request:{method,params:{tx_json:tx,autofill:submit,submit}}});
    const result=reply?.result ?? reply;
    if (typeof result?.tx_json==='object') return result.tx_json;
    const blob=result?.tx_blob ?? result?.signedTransaction;
    if (typeof blob==='string' && /^[0-9a-f]+$/i.test(blob)) return sdk.decode(blob);
    return result;
  }
  async function signReservation(network,buyer,message) {
    if (network!=='Testnet') throw Error('WalletConnect · XRPL Testnet');
    const response=await request(network,buyer,reservationEnvelope(buyer,message),false);
    if (!response?.SigningPubKey || !response.TxnSignature) throw Error('WalletConnect · missing reservation signature');
    return {publicKey:response.SigningPubKey,signature:response.TxnSignature};
  }
  async function acceptOffer(network,buyer,quote) {
    if (quote?.price!=='10000000' || !/^[A-F0-9]{64}$/.test(quote.id) || !Number.isSafeInteger(quote.validThrough) || quote.validThrough<=1)
      throw Error('WalletConnect · invalid NFT offer');
    const result=await request(network,buyer,{TransactionType:'NFTokenAcceptOffer',Account:buyer,
      NFTokenSellOffer:quote.id,LastLedgerSequence:quote.validThrough},true);
    return result?.hash ?? result?.txid;
  }
  return {connect,signReservation,acceptOffer};
}
