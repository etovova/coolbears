import { settings as S } from './settings.mjs';
import { createClient, readState, prepareMint, readOperation, saveOperation, mayStart, withMintLock, settleOperation, assetUrl, signatureUrl, requireValue, boundedWalletCall } from './core.mjs';
import { connectWallet } from './wallet.mjs';
import { phantomBrowseUrl, solflareBrowseUrl } from '../wallet-core.mjs';

const $ = id => document.getElementById(id);
const client = createClient();
let wallet = null;
let busy = false;
let ready = false;
let operation = null;
let storageError = false;
const message = text => { $('status').textContent = text; };

function render() {
  $('mint').disabled = busy || storageError || !ready || wallet?.address !== S.owner || !mayStart(operation);
  $('check').disabled = busy || storageError;
  $('phantom').disabled = busy;
  $('solflare').disabled = busy;
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
function persist(value) { saveOperation(localStorage, value); operation = value; render(); }
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
  catch (error) { message(error.message || String(error)); }
  finally { busy = false; render(); }
}
async function recover() {
  message('Проверяю сохранённую операцию в Devnet…');
  operation = await settleOperation(client, operation, { onProgress: persist });
  persist(operation); report(operation);
}
async function check() {
  await withMintLock(navigator.locks, async () => {
    loadSaved(); requireValue(!storageError, 'Нужна проверка сохранённого журнала');
    if (operation && !mayStart(operation)) return recover();
    message('Проверяю Devnet и условия минта…');
    const state = await readState(client);
    ready = state.machine.itemsRedeemed === 1n;
    message(ready ? 'Devnet доступен. Подключи FNyt…CW6y и выпусти один тестовый NFT.' : 'Оба тестовых NFT уже выпущены.');
  });
}
async function connect(name) {
  wallet?.off(); wallet = null;
  message(`Подключение ${name}…`);
  wallet = await boundedWalletCall(connectWallet(name, () => { wallet?.off(); wallet = null; ready = false; message('Аккаунт кошелька изменился. Подключись снова.'); render(); }));
  requireValue(wallet.address === S.owner, 'Выбери в кошельке адрес FNyt…CW6y. Этот тест доступен только ему.');
  await check();
}

$('phantom').onclick = () => action(() => connect('Phantom'));
$('solflare').onclick = () => action(() => connect('Solflare'));
$('check').onclick = () => action(check);
$('mint').onclick = () => action(() => withMintLock(navigator.locks, async () => {
  loadSaved(); requireValue(!storageError && mayStart(operation), 'Сначала проверь сохранённую операцию');
  requireValue(wallet?.address === S.owner, 'Подключи FNyt…CW6y');
  const selectedWallet = wallet;
  message('Проверяю условия и симулирую минт…');
  const prepared = await prepareMint(client, selectedWallet.address);
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
  const record = { exportedAt: new Date().toISOString(), page: location.origin + location.pathname, operation: localStorage.getItem(S.storageKey), status: $('status').textContent };
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
if (operation && !storageError) report(operation);
// No automatic wallet prompts, signing, resubmission, or polling after reload.
