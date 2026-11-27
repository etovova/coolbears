const oauth = 'https://oauth2.xumm.app';
const payloadApi = 'https://xumm.app/api/v1/jwt/payload';
const address = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const callback = () => location.origin + '/xrpl/';
const key = (network, kind) => 'coolbears.xaman.' + network + '.' + kind;
const saved = (network, kind) => JSON.parse(sessionStorage.getItem(key(network, kind)) || 'null');
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function request(url, options) {
  const response = await fetch(url, {...options, cache:'no-store', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(18000)});
  if (!response.ok) throw Error('Xaman (HTTP ' + response.status + ')');
  const result = await response.json();
  if (result.error) throw Error('Xaman · ' + String(result.error.code || result.error));
  return result;
}

export function session(config) {
  const entry = saved(config.network, 'session');
  return entry?.client === config.xamanClientId && entry.expires > Date.now() ? entry : null;
}

export async function authorize(config, ownerSetup = false) {
  const verifier = random(), state = (ownerSetup ? 'issuer-' : '') + random();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    response_type:'code', scope:'XummPkce', client_id:config.xamanClientId, redirect_uri:callback(),
    code_challenge:base64url(new Uint8Array(hash)), code_challenge_method:'S256', state,
    force_network:config.network.toUpperCase()
  });
  // A mobile deep link may return to another tab in the same browser.
  localStorage.setItem(key(config.network, 'login'), JSON.stringify({state, verifier, client:config.xamanClientId, started:Date.now()}));
  location.assign(oauth + '/auth?' + params);
}

export async function finishLogin(config) {
  const params = new URLSearchParams(location.search);
  if (location.pathname !== '/xrpl/' || !(params.has('code') || params.has('error'))) return null;
  history.replaceState(null, '', '/xrpl/');
  const login = JSON.parse(localStorage.getItem(key(config.network, 'login')) || 'null') || saved(config.network,'login');
  if (!login || login.client !== config.xamanClientId || !login.state || login.state !== params.get('state') || Date.now() - login.started > 15*60*1000)
    throw Error('Xaman · Invalid sign-in session');
  localStorage.removeItem(key(config.network, 'login'));
  sessionStorage.removeItem(key(config.network, 'login'));
  if (params.has('error') || !params.get('code')) throw Error('Xaman · Sign-in cancelled');
  const token = await request(oauth + '/token', {method:'POST', body:new URLSearchParams({
    grant_type:'authorization_code', code:params.get('code'), client_id:login.client,
    redirect_uri:callback(), code_verifier:login.verifier
  })});
  if (!token.access_token) throw Error('Xaman · Missing access token');
  const profile = await request(oauth + '/userinfo', {headers:{Authorization:'Bearer ' + token.access_token}});
  if (!address.test(profile.account) || profile.blocked || profile.networkType?.toUpperCase() !== config.network.toUpperCase())
    throw Error('Xaman · Select XRPL ' + config.network);
  const seconds = Math.min(Number(token.expires_in ?? 86400), 86400);
  if (!(seconds > 0)) throw Error('Xaman · Expired sign-in');
  const entry = {account:profile.account, token:token.access_token, expires:Date.now()+seconds*1000, client:login.client};
  sessionStorage.setItem(key(config.network, 'session'),JSON.stringify(entry));
  return entry;
}

export function signingUrl(id, url) {
  if (!uuid.test(id) || !url) return null;
  const allowed = ['https://xumm.app/sign/', 'https://xaman.app/sign/'];
  return allowed.some(prefix => url === prefix + id) ? url : null;
}

export function confirmationPlan(remaining, grouped) {
  if (!Number.isInteger(remaining) || remaining<0 || remaining>50) throw Error('Invalid order quantity');
  const limit=grouped ? 8 : 1;
  return {next:Math.min(remaining,limit), confirmations:Math.ceil(remaining/limit)};
}

export function purchaseTransaction(pending) {
  const common={Account:pending.buyer,LastLedgerSequence:pending.last};
  if (!pending.offers) return {TransactionType:'NFTokenAcceptOffer',...common,NFTokenSellOffer:pending.offer};
  const {offers,sequence,fee}=pending;
  if (!address.test(pending.buyer) || !Number.isSafeInteger(pending.last) || pending.last<16 ||
      !Array.isArray(offers) || offers.length<2 || offers.length>8 || new Set(offers).size!==offers.length ||
      offers.some(id=>!/^([A-F0-9]{64})$/.test(id)) || !Number.isSafeInteger(sequence) || sequence<1 ||
      sequence+offers.length>0xffffffff || !/^[1-9]\d*$/.test(fee) || Number(fee)>(offers.length+2)*100)
    throw Error('Invalid NFT batch');
  return {TransactionType:'Batch',...common,Flags:65536,Sequence:sequence,Fee:fee,
    RawTransactions:offers.map((id,i)=>({RawTransaction:{TransactionType:'NFTokenAcceptOffer',
      Account:pending.buyer,NFTokenSellOffer:id,Flags:0x40000000,Fee:'0',SigningPubKey:'',Sequence:sequence+i+1}}))};
}

export async function createOfferSignature(config, pending) {
  const user = session(config);
  if (!user || user.account !== pending.buyer) throw Error('Xaman · Sign in again');
  const result = await request(payloadApi, {method:'POST',
    headers:{Authorization:'Bearer ' + user.token,'Content-Type':'application/json'},
    body:JSON.stringify({
      txjson:purchaseTransaction(pending),
      options:{submit:true, expire:1, force_network:config.network.toUpperCase(), signers:[user.account],
        return_url:{web:callback(), app:callback()}}
    })
  });
  const url = signingUrl(result.uuid, result.next?.always);
  if (!url) throw Error('Xaman · Invalid signing link');
  return {id:result.uuid, url};
}

export async function signatureResult(config, pending) {
  const user = session(config);
  if (!user || user.account !== pending.buyer || !uuid.test(pending.xaman?.id)) return null;
  const result = await request(payloadApi + '/' + pending.xaman.id, {headers:{Authorization:'Bearer ' + user.token}});
  const {meta, response} = result;
  if (meta?.uuid !== pending.xaman.id) throw Error('Xaman · Unexpected request');
  if (!meta.signed) return meta.resolved || meta.cancelled || meta.expired ? {declined:true} : null;
  if (meta.resolved && response?.account === user.account && response.dispatched_nodetype?.toUpperCase() === config.network.toUpperCase()
      && /^[A-Fa-f0-9]{64}$/.test(response.txid)) return {hash:response.txid.toUpperCase()};
  return null;
}
