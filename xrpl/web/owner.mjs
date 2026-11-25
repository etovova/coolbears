import {authorize, finishLogin, session, signingUrl} from '/xrpl/xaman.mjs';

const ownerPath = '/xrpl/owner/';
const action = document.querySelector('#action');
const refresh = document.querySelector('#refresh');
const status = document.querySelector('#status');
const pendingKey = 'coolbears.xaman.Mainnet.ownerRequest';
let config;
let ledger;
let busy = false;

async function read(url) {
  const r = await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if (!r.ok) throw Error('Не удалось проверить состояние в Mainnet. Нажми «Проверить состояние».');
  return r.json();
}
async function load() {
  action.hidden = true;
  config = await read('/xrpl/api/status');
  if (location.hostname !== 'coolbears-nfts.com' || config.network !== 'Mainnet' || !config.xamanClientId)
    throw Error('Проверь домен и сеть CoolBears.');
  if (location.pathname === '/xrpl/') {
    try { await finishLogin(config); }
    finally { history.replaceState(null,'',ownerPath); }
  }
  ledger = await read(ownerPath + 'status');
  document.querySelector('#issuer').textContent = ledger.tx.Account;
  document.querySelector('#delegate').textContent = ledger.tx.Authorize;
  if (ledger.state === 'active') {
    localStorage.removeItem(pendingKey);
    status.textContent = 'Оба разрешения подтверждены в Mainnet. Реестр № ' + ledger.ledger + '.';
    return;
  }
  if (ledger.state !== 'absent' || ledger.tx.Account !== config.issuer)
    throw Error('Права или адрес эмитента отличаются от ожидаемых. Создание запроса остановлено.');
  const user = session(config);
  if (user && user.account !== config.issuer) {
    status.textContent = 'Выбран другой кошелёк. Выбери кошелёк эмитента при входе.';
    action.textContent = 'Выбрать кошелёк эмитента';
  } else {
    const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
    const url = pending && pending.until > Date.now() && signingUrl(pending.id,pending.url);
    if (url) {
      status.textContent = 'Запрос создан. Если ты уже подписал его в Xaman, нажми «Проверить состояние».';
      action.textContent = 'Открыть запрос в Xaman';
      action.onclick = () => location.assign(url);
      action.hidden = false;
      return;
    }
    status.textContent = 'Разрешение ещё не выдано. Проверен реестр № ' + ledger.ledger + '.';
    action.textContent = user ? 'Проверить и подписать в Xaman' : 'Войти через Xaman';
  }
  action.hidden = false;
  action.onclick = () => run(user?.account === config.issuer ? createRequest : () => authorize(config,true));
}

async function createRequest() {
  const current = await read(ownerPath + 'status');
  if (current.state !== 'absent' || JSON.stringify(current.tx) !== JSON.stringify(ledger.tx)) return load();
  const user = session(config);
  if (!user || user.account !== current.tx.Account) return load();
  const back = location.origin + ownerPath;
  const r = await fetch('https://xumm.app/api/v1/jwt/payload',{
    method:'POST', credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
    signal:AbortSignal.timeout(18000),
    headers:{Authorization:'Bearer ' + user.token,'Content-Type':'application/json'},
    body:JSON.stringify({txjson:{...current.tx,Fee:'12',LastLedgerSequence:current.ledger+70},
      options:{submit:true,expire:3,force_network:'MAINNET',signers:[user.account],return_url:{web:back,app:back}}})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    if (r.status === 401) {
      action.textContent = 'Войти через Xaman ещё раз';
      action.onclick = () => run(() => authorize(config,true));
    }
    throw Error('Xaman отклонил запрос DelegateSet. HTTP ' + r.status +
      (data.error?.code ? ' · код ' + String(data.error.code).slice(0,80) : '') +
      (typeof data.error?.message === 'string' ? ' · ' + data.error.message.slice(0,240) : ''));
  }
  const url = signingUrl(data.uuid,data.next?.always);
  if (!url) throw Error('Xaman не вернул ссылку для подписи.');
  localStorage.setItem(pendingKey,JSON.stringify({id:data.uuid,url,until:Date.now()+180000}));
  location.assign(url);
}

async function run(work) {
  if (busy) return;
  busy = true;
  action.disabled = refresh.disabled = true;
  try { await work(); }
  catch (e) { status.textContent = e.message; }
  finally { busy = false; action.disabled = refresh.disabled = false; }
}
refresh.onclick = () => run(load);
window.addEventListener('pageshow', e => { if (e.persisted) run(load); });
await run(load);
