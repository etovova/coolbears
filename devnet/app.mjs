import { settings as S } from './settings.mjs';
import { createClient, readState, prepareMint, readOperation, saveOperation, mayStart, withMintLock, settleOperation, assetUrl, signatureUrl, requireValue, boundedWalletCall, mergeOperationEvidence, validateOperation } from './core.mjs';
import { connectWallet, getAvailableWallets, subscribeWallets, walletConnectionAction } from './wallet.mjs';
import { validateRpcEndpoint } from './rpc.mjs';
import { phantomBrowseUrl, solflareBrowseUrl, backpackBrowseUrl } from '../wallet-core.mjs';

const $ = id => document.getElementById(id);
const publicEndpoint = validateRpcEndpoint(S.rpc);
let endpoint = publicEndpoint;
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
  const options = available.filter(item => !['Phantom', 'Solflare', 'Backpack'].includes(item.name) || available.filter(other => other.name === item.name).length > 1);
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
  $('backpack').disabled = busy;
  $('connect-other').disabled = busy;
  $('wallet-choice').disabled = busy;
  $('rpc-apply').disabled = busy;
  $('rpc-reset').disabled = busy;
  $('rpc-endpoint').disabled = busy;
  $('phantom').textContent = wallet?.name === 'Phantom' ? 'Phantom подключён' : walletConnectionAction('Phantom', window, location.origin + '/devnet/').type === 'browse' ? 'Открыть Phantom' : 'Подключить Phantom';
  $('solflare').textContent = wallet?.name === 'Solflare' ? 'Solflare подключён' : 'Solflare';
  $('backpack').textContent = wallet?.name === 'Backpack' ? 'Backpack подключён' : 'Backpack';
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
  catch { storageError = true; message('Сохранённую операцию не удалось прочитать. Открой «Показать результат проверки».'); }
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
    expired: 'Срок транзакции истёк. Проверено: этот NFT не создан.',
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
  ready = false;
  message('Проверяю сохранённую операцию в Devnet…');
  await runNetwork(async client => {
    const result = await settleOperation(client, operation, { onProgress: persist });
    // Save the terminal proof before the readiness check, which can fail on its
    // own. Both checks share the same deadline; neither signs nor resubmits.
    persist(result);
    if (['expired', 'failed'].includes(operation.stage) && mayStart(operation)) {
      const state = await readState(client);
      // A late wallet response may have added stronger evidence while reading.
      if (mayStart(operation)) {
        ready = state.machine.itemsRedeemed === 1n;
        report(operation);
        const next = ready
          ? wallet?.address === S.owner ? 'Можно начать новую попытку.' : 'Подключи FNyt…CW6y для новой попытки.'
          : 'Оба тестовых NFT уже выпущены.';
        message(`${$('status').textContent} ${next}`);
        return;
      }
    }
    report(operation);
  });
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
$('backpack').onclick = () => action(() => connect('Backpack'));
$('connect-other').onclick = () => action(() => connect($('wallet-choice').value));
$('rpc-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const next = validateRpcEndpoint($('rpc-endpoint').value.trim());
    $('rpc-endpoint').value = '';
    if (endpoint !== next) { endpoint = next; client = newClient(); }
    ready = false;
    $('rpc-current').textContent = endpoint === publicEndpoint ? 'Используется общий Devnet RPC.' : 'Используется свой Devnet RPC до перезагрузки страницы.';
    await check();
  });
};
$('rpc-reset').onclick = () => action(async () => {
  if (endpoint !== publicEndpoint) { endpoint = publicEndpoint; client = newClient(); }
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
function diagnosticText() {
  let saved = operation, unreadable = storageError, publicOperation = null;
  try { saved = readOperation(localStorage) || saved; } catch { unreadable = true; }
  // Export only validated public recovery coordinates, never raw storage or
  // arbitrary extra fields. A corrupt journal remains untouched in the browser.
  if (saved) {
    try {
      validateOperation(saved);
      publicOperation = Object.fromEntries(['version', 'cluster', 'owner', 'machine', 'collection', 'asset', 'blockhash', 'lastValidBlockHeight', 'stage', 'signature'].map(key => [key, saved[key]]));
    } catch { unreadable = true; }
  }
  const httpStatus = /RPC HTTP (\d{3}):/.exec($('status').textContent)?.[1];
  // Wallet error messages can contain arbitrary text. Diagnostics use fixed
  // labels instead of copying those messages or a provider URL/API key.
  const status = httpStatus ? `RPC HTTP ${httpStatus}` : unreadable ? 'Не удалось прочитать сохранённую операцию' : busy ? 'Проверка выполняется' : ready ? 'Devnet доступен' : 'См. состояние операции и сообщение на странице';
  return JSON.stringify({
    exportedAt: new Date().toISOString(), page: location.origin + '/devnet/',
    appVersion: 'devnet-20260922-4', operation: publicOperation, storageError: unreadable,
    rpc: endpoint === publicEndpoint ? 'public-devnet' : 'custom-devnet',
    rpcProvider: endpoint === publicEndpoint ? 'solana-public' : new URL(endpoint).hostname === 'devnet.helius-rpc.com' ? 'helius' : 'other',
    walletConnected: Boolean(wallet), ownerConnected: wallet?.address === S.owner,
    busy, ready, status,
  }, null, 2);
}
function showDiagnostic() {
  $('report-text').value = diagnosticText();
  $('report-copy-status').textContent = '';
}
$('diagnostic-report').ontoggle = () => { if ($('diagnostic-report').open) showDiagnostic(); };
$('copy-report').onclick = async () => {
  const text = $('report-text').value;
  try {
    if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    $('report-copy-status').textContent = 'Отчёт скопирован. Вставь его в чат.';
  } catch {
    $('report-text').focus(); $('report-text').select();
    $('report-text').setSelectionRange(0, text.length);
    $('report-copy-status').textContent = 'Автокопирование недоступно. Текст выделен: скопируй его вручную или пришли скриншот отчёта.';
  }
};
$('download').onclick = () => {
  showDiagnostic(); $('diagnostic-report').open = true;
  const url = URL.createObjectURL(new Blob([$('report-text').value], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'CoolBears-Devnet-result.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (location.protocol === 'https:') {
  $('open-phantom').href = phantomBrowseUrl(location.origin + '/devnet/');
  $('open-solflare').href = solflareBrowseUrl(location.origin + '/devnet/');
  $('open-backpack').href = backpackBrowseUrl(location.origin + '/devnet/');
} else { $('mobile-links').hidden = true; }
window.addEventListener('storage', event => { if (event.key === S.storageKey && !busy) { loadSaved(); render(); } });
loadSaved(); render();
updateWalletOptions();
subscribeWallets(updateWalletOptions);
if (operation && !storageError) report(operation);
// No automatic wallet prompts, signing, resubmission, or polling after reload.
