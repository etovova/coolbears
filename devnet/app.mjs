import { settings as S } from './settings.mjs';
import { createClient, readState, prepareMint, readOperation, saveOperation, mayStart, withMintLock, settleOperation, assetUrl, signatureUrl, requireValue, boundedWalletCall, mergeOperationEvidence } from './core.mjs';
import { connectWallet, getAvailableWallets, subscribeWallets, walletConnectionAction } from './wallet.mjs';
import { validateRpcEndpoint } from './rpc.mjs';
import { phantomBrowseUrl, solflareBrowseUrl } from '../wallet-core.mjs';

const $ = id => document.getElementById(id);
let endpoint = S.rpc;
let networkController = null;
const newClient = () => createClient(globalThis.fetch, {
  endpoint, getSignal: () => networkController?.signal,
  onRetry: ({ delayMs, attempt, maxAttempts }) => message(`Сервер Devnet занят или временно недоступен. Повтор проверки через ${Math.ceil(delayMs / 1000)} сек. (${attempt}/${maxAttempts})`),
});
let client = newClient();
let wallet = null;
let walletGeneration = 0;
let busy = false;
let ready = false;
let operation = null;
let storageError = false;
const message = text => { $('status').textContent = text; };
async function runNetwork(callback) {
  const controller = new AbortController();
  networkController = controller;
  const timeout = setTimeout(() => controller.abort(), 90000);
  try { return await callback(client); }
  catch (error) { if (controller.signal.aborted) throw Error('Проверка Devnet не завершилась за 90 секунд. Журнал сохранён; можно проверить результат позже.'); throw error; }
  finally { clearTimeout(timeout); controller.abort(); if (networkController === controller) networkController = null; }
}
function updateWalletOptions() {
  const selected = $('wallet-choice').value;
  const available = getAvailableWallets();
  const options = available.filter(item => !['Phantom', 'Solflare'].includes(item.name) || available.filter(other => other.name === item.name).length > 1);
  $('wallet-choice').replaceChildren(...options.map(item => {
    const option = document.createElement('option'); option.value = item.id;
    option.textContent = options.filter(other => other.name === item.name).length > 1 ? `${item.name} (${item.id})` : item.name;
    return option;
  }));
  if (options.some(item => item.id === selected)) $('wallet-choice').value = selected;
  $('other-wallets').hidden = !options.length;
  render();
}

function render() {
  $('mint').disabled = busy || storageError || !ready || wallet?.address !== S.owner || !mayStart(operation);
  $('check').disabled = busy || storageError;
  $('phantom').disabled = busy;
  $('solflare').disabled = busy;
  $('connect-other').disabled = busy;
  $('wallet-choice').disabled = busy;
  $('rpc-apply').disabled = busy;
  $('rpc-reset').disabled = busy;
  $('rpc-endpoint').disabled = busy;
  $('phantom').textContent = wallet?.name === 'Phantom' ? 'Phantom подключён' : walletConnectionAction('Phantom', window, location.origin + '/devnet/').type === 'browse' ? 'Открыть Phantom' : 'Подключить Phantom';
  $('solflare').textContent = wallet?.name === 'Solflare' ? 'Solflare подключён' : 'Solflare';
  $('wallet').textContent = wallet?.address || 'Кошелёк не подключён';
  $('result').hidden = !operation;
  if (operation) {
    $('asset').href = assetUrl(operation.asset);
    $('asset').textContent = operation.name || operation.asset;
    $('signature').hidden = !operation.signature;
    if (operation.signature) $('signature').href = signatureUrl(operation.signature);
    $('saved').textContent = operation.stage === 'verified' ? 'NFT подтверждён в Devnet' : 'Операция сохранена в этом браузере';
  }
}
function loadSaved() {
  try { operation = readOperation(localStorage); }
  catch { storageError = true; message('Сохранённую операцию не удалось прочитать. Скачай журнал для проверки.'); }
}
function persist(value) {
  const saved = readOperation(localStorage);
  value = mergeOperationEvidence(value, saved);
  saveOperation(localStorage, value); operation = value; render();
}
function report(value) {
  const texts = {
    verified: 'NFT выпущен и проверен: владелец, коллекция и метаданные совпадают.',
    failed: 'Транзакция завершилась ошибкой. NFT не создан.',
    expired: 'Срок транзакции истёк. Проверено: этот NFT не создан. Можно начать новую попытку.',
    cancelled: 'Подпись отменена в кошельке.',
  };
  message(texts[value.stage] || 'Результат пока не подтверждён. Нажми «Проверить результат» — это не отправляет новую транзакцию.');
}
async function action(callback) {
  if (busy) return;
  busy = true; render();
  try { await callback(); }
  catch (error) { ready = false; message(error.message || 'Не удалось завершить проверку.'); }
  finally { busy = false; render(); }
}
async function recover() {
  message('Проверяю сохранённую операцию в Devnet…');
  const result = await runNetwork(client => settleOperation(client, operation, { onProgress: persist }));
  persist(result); report(operation);
}
async function check() {
  await withMintLock(navigator.locks, async () => {
    loadSaved(); requireValue(!storageError, 'Нужна проверка сохранённого журнала');
    if (operation && !mayStart(operation)) return recover();
    ready = false;
    message('Проверяю Devnet и условия минта… При занятом сервере проверка повторится с паузой.');
    const state = await runNetwork(readState);
    ready = state.machine.itemsRedeemed === 1n;
    message(ready ? wallet?.address === S.owner ? 'Кошелёк подключён. Devnet доступен. Можно выпустить один тестовый NFT.' : 'Devnet доступен. Подключи FNyt…CW6y и выпусти один тестовый NFT.' : 'Оба тестовых NFT уже выпущены.');
  });
}
async function connect(name) {
  const action = walletConnectionAction(name, window, location.origin + '/devnet/');
  if (action.type === 'browse') { message('Открываю страницу в приложении кошелька…'); location.assign(action.url); return; }
  if ((wallet?.name === name || wallet?.id === name) && wallet.address === S.owner) return check();
  const generation = ++walletGeneration;
  wallet?.off(); wallet = null;
  ready = false;
  message(`Подключение ${name}…`);
  const connected = await connectWallet(name, () => {
    if (walletGeneration !== generation) return;
    ++walletGeneration; wallet?.off(); wallet = null; ready = false;
    message('Аккаунт кошелька изменился. Подключись снова.'); render();
  });
  if (walletGeneration !== generation) { connected.off(); throw Error('Аккаунт кошелька изменился. Подключись снова.'); }
  wallet = connected;
  requireValue(wallet.address === S.owner, 'Выбери в кошельке адрес FNyt…CW6y. Этот тест доступен только ему.');
  await check();
}

$('phantom').onclick = () => action(() => connect('Phantom'));
$('solflare').onclick = () => action(() => connect('Solflare'));
$('connect-other').onclick = () => action(() => connect($('wallet-choice').value));
$('rpc-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const next = validateRpcEndpoint($('rpc-endpoint').value.trim());
    $('rpc-endpoint').value = '';
    if (endpoint !== next) { endpoint = next; client = newClient(); }
    ready = false;
    $('rpc-current').textContent = 'Используется свой Devnet RPC до перезагрузки страницы.';
    await check();
  });
};
$('rpc-reset').onclick = () => action(async () => {
  if (endpoint !== S.rpc) { endpoint = S.rpc; client = newClient(); }
  $('rpc-endpoint').value = ''; ready = false;
  $('rpc-current').textContent = 'Используется общий Devnet RPC.';
  await check();
});
$('check').onclick = () => action(check);
$('mint').onclick = () => action(() => withMintLock(navigator.locks, async () => {
  loadSaved(); requireValue(!storageError && mayStart(operation), 'Сначала проверь сохранённую операцию');
  requireValue(wallet?.address === S.owner, 'Подключи FNyt…CW6y');
  const selectedWallet = wallet;
  message('Проверяю условия и симулирую минт…');
  const prepared = await runNetwork(client => prepareMint(client, selectedWallet.address));
  requireValue(wallet === selectedWallet, 'Кошелёк изменился во время подготовки');
  // Public recovery coordinates are durable BEFORE the wallet prompt.
  if (operation) localStorage.setItem(`${S.storageKey}:history:${operation.asset}`, JSON.stringify(operation));
  persist(prepared.operation);
  message('Подтверди один тестовый минт в кошельке. Сеть: Devnet.');
  // A wallet prompt can outlive this page. Never clear pending on timeout.
  const waiting = setTimeout(() => message('Ожидаю ответа кошелька. Если окно закрылось, после возвращения нажми «Проверить результат».'), 25000);
  try {
    const pending = selectedWallet.send(prepared.bytes).then(signature => {
      // A response after the visible timeout still belongs to this saved asset.
      const saved = readOperation(localStorage);
      if (saved?.asset === prepared.operation.asset) persist({ ...saved, signature, stage: saved.stage === 'verified' ? 'verified' : 'submitted' });
      return signature;
    });
    const signature = await boundedWalletCall(pending);
    persist({ ...operation, signature, stage: 'submitted' });
  } catch (error) {
    const rejected = error.code === 4001 || error.cause?.code === 4001;
    persist({ ...operation, stage: rejected ? 'cancelled' : 'unknown' });
    if (rejected) { report(operation); return; }
    message('Ответ кошелька не получен. Проверяю сохранённый адрес NFT…');
  } finally { clearTimeout(waiting); }
  await recover();
}));
$('download').onclick = () => {
  let stored = null;
  try { stored = localStorage.getItem(S.storageKey); } catch { /* Export the in-memory recovery record when storage is blocked. */ }
  const record = { exportedAt: new Date().toISOString(), page: location.origin + location.pathname, operation: operation || stored, storageError, rpc: endpoint === S.rpc ? 'public-devnet' : 'custom-devnet', status: $('status').textContent };
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'CoolBears-Devnet-result.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (location.protocol === 'https:') {
  $('open-phantom').href = phantomBrowseUrl(location.origin + '/devnet/');
  $('open-solflare').href = solflareBrowseUrl(location.origin + '/devnet/');
} else { $('mobile-links').hidden = true; }
window.addEventListener('storage', event => { if (event.key === S.storageKey && !busy) { loadSaved(); render(); } });
loadSaved(); render();
updateWalletOptions();
subscribeWallets(updateWalletOptions);
if (operation && !storageError) report(operation);
// No automatic wallet prompts, signing, resubmission, or polling after reload.
