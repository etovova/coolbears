import { settings as S } from './settings.mjs';
import { createClient, readState, prepareMint, readOperation, saveOperation, mayStart, withMintLock, settleOperation, assetUrl, signatureUrl, requireValue, boundedWalletCall, mergeOperationEvidence, validateOperation } from './core.mjs';
import { connectWallet, getAvailableWallets, subscribeWallets, walletConnectionAction, hasPhantomSigner, connectPhantomSigner } from './wallet.mjs';
import { validateRpcEndpoint } from './rpc.mjs';
import { walletErrorDetails, publicWalletAttempt, publicPreparation, publicSubmission } from './diagnostics.mjs';
import { signAndSubmit } from './submission.mjs';
import { validateSubmissionEndpoint } from './sender.mjs';
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
const canSubmitCustom = () => { try { validateSubmissionEndpoint(endpoint); return true; } catch { return false; } };
const message = text => { $('status').textContent = text; };
async function runNetwork(callback, timeoutMs = 90000) {
  const controller = new AbortController();
  networkController = controller;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await callback(client); }
  catch (error) { if (controller.signal.aborted) throw Error(`Проверка Devnet не завершилась за ${Math.ceil(timeoutMs / 1000)} секунд. Журнал сохранён; можно проверить результат позже.`); throw error; }
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
  $('phantom-rpc-option').hidden = !canSubmitCustom() || !hasPhantomSigner();
  $('phantom-rpc').disabled = busy || storageError;
  $('phantom-rpc').textContent = wallet?.route === 'custom-rpc' ? 'Phantom: свой RPC выбран' : 'Phantom: отправлять через свой RPC';
  $('wallet-route').hidden = !wallet;
  $('wallet-route').textContent = wallet?.route === 'custom-rpc' ? 'Подпись: Phantom. Отправка: свой Devnet RPC.' : 'Подпись и отправка: приложение кошелька.';
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
async function connect(name, customRpc = false) {
  if (customRpc) requireValue(canSubmitCustom() && hasPhantomSigner(), 'Сначала настрой свой Devnet RPC и открой страницу внутри Phantom.');
  const action = walletConnectionAction(name, window, location.origin + '/devnet/');
  if (!customRpc && action.type === 'browse') { message('Открываю страницу в приложении кошелька…'); location.assign(action.url); return; }
  if ((wallet?.name === name || wallet?.id === name) && wallet.address === S.owner && (wallet.route === 'custom-rpc') === customRpc) return check();
  const generation = ++walletGeneration;
  wallet?.off(); wallet = null;
  ready = false;
  message(`Подключение ${name}…`);
  const changed = () => {
    if (walletGeneration !== generation) return;
    ++walletGeneration; wallet?.off(); wallet = null; ready = false;
    message('Аккаунт кошелька изменился. Подключись снова.'); render();
  };
  const connected = customRpc ? await connectPhantomSigner(changed) : await connectWallet(name, changed);
  if (walletGeneration !== generation) { connected.off(); throw Error('Аккаунт кошелька изменился. Подключись снова.'); }
  wallet = connected;
  requireValue(wallet.address === S.owner, 'Выбери в кошельке адрес FNyt…CW6y. Этот тест доступен только ему.');
  await check();
}

$('phantom').onclick = () => action(() => connect('Phantom'));
$('solflare').onclick = () => action(() => connect('Solflare'));
$('backpack').onclick = () => action(() => connect('Backpack'));
$('phantom-rpc').onclick = () => action(() => connect('Phantom', true));
$('connect-other').onclick = () => action(() => connect($('wallet-choice').value));
function changeEndpoint(next) {
  if (endpoint === next) return;
  endpoint = next; client = newClient();
  // A selected sign-only session is bound to the endpoint chosen at connection.
  if (wallet?.route === 'custom-rpc') { ++walletGeneration; wallet.off(); wallet = null; }
}
$('rpc-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const next = validateRpcEndpoint($('rpc-endpoint').value.trim());
    $('rpc-endpoint').value = '';
    changeEndpoint(next);
    ready = false;
    $('rpc-current').textContent = endpoint === publicEndpoint ? 'Используется общий Devnet RPC.' : 'Используется свой Devnet RPC до перезагрузки страницы.';
    await check();
  });
};
$('rpc-reset').onclick = () => action(async () => {
  changeEndpoint(publicEndpoint);
  $('rpc-endpoint').value = ''; ready = false;
  $('rpc-current').textContent = 'Используется общий Devnet RPC.';
  await check();
});
$('check').onclick = () => action(check);
$('mint').onclick = () => action(() => withMintLock(navigator.locks, async () => {
  loadSaved(); requireValue(!storageError && mayStart(operation), 'Сначала проверь сохранённую операцию');
  requireValue(wallet?.address === S.owner, 'Подключи FNyt…CW6y');
  const selectedWallet = wallet;
  const selectedEndpoint = endpoint;
  if (selectedWallet.route === 'custom-rpc') validateSubmissionEndpoint(selectedEndpoint);
  const generation = walletGeneration;
  const isActive = () => wallet === selectedWallet && walletGeneration === generation && endpoint === selectedEndpoint;
  message('Проверяю условия и симулирую минт…');
  const prepared = await runNetwork(client => prepareMint(client, selectedWallet.address));
  requireValue(isActive(), 'Кошелёк изменился во время подготовки');
  // Public recovery coordinates are durable BEFORE the wallet prompt.
  if (operation) localStorage.setItem(`${S.storageKey}:history:${operation.asset}`, JSON.stringify(operation));
  const walletName = selectedWallet.name.toLowerCase();
  persist({ ...prepared.operation, walletAttempt: {
    wallet: ['phantom', 'solflare', 'backpack'].includes(walletName) ? walletName : 'other',
    transport: selectedWallet.transport, requestedAt: new Date().toISOString(), outcome: 'pending',
    method: selectedWallet.route === 'custom-rpc' ? 'signTransaction' : 'signAndSendTransaction',
  } });
  message('Подтверди один тестовый минт в кошельке. Сеть: Devnet.');
  // A wallet prompt can outlive this page. Never clear pending on timeout.
  const waiting = setTimeout(() => message('Ожидаю ответа кошелька. Если окно закрылось, после возвращения нажми «Проверить результат».'), 25000);
  try {
    if (selectedWallet.route === 'custom-rpc') {
      await signAndSubmit({
        prepared, wallet: selectedWallet, endpoint: selectedEndpoint, isActive,
        readSaved: () => readOperation(localStorage),
        persist: value => {
          persist(value);
          if (value.walletAttempt?.outcome !== 'pending') clearTimeout(waiting);
          if (isActive() && value.submission?.state === 'sending') message('Подпись проверена. Отправляю транзакцию через свой Devnet RPC…');
        },
        checkFresh: () => runNetwork(async client => {
          requireValue(await client.rpc('getGenesisHash') === S.genesis, 'Требуется Solana Devnet');
          const height = await client.rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
          requireValue(Number.isSafeInteger(height) && height >= 0 && prepared.operation.lastValidBlockHeight - height >= 10, 'Срок подписанной транзакции заканчивается. Отправка не выполнялась.');
          const valid = await client.rpc('isBlockhashValid', [prepared.operation.blockhash, { commitment: 'confirmed' }]);
          requireValue(valid?.value === true, 'Срок подписанной транзакции истёк. Отправка не выполнялась.');
        }, 20000),
      });
    } else {
    const pending = Promise.resolve().then(() => selectedWallet.send(prepared.bytes)).then(signature => {
      // A response after the visible timeout still belongs to this saved asset.
      const saved = readOperation(localStorage);
      if (saved?.asset === prepared.operation.asset) persist({ ...saved, signature, stage: saved.stage === 'verified' ? 'verified' : 'submitted',
        walletAttempt: { ...saved.walletAttempt, outcome: 'submitted', responseAt: new Date().toISOString() },
      });
      return signature;
    }, error => {
      // A late error is useful evidence too. Never retain the raw message,
      // which can contain credentials, or overwrite a different attempt.
      const saved = readOperation(localStorage);
      if (saved?.asset === prepared.operation.asset) {
        const details = walletErrorDetails(error);
        const rejected = details.errorCategory === 'user-rejected';
        persist({ ...saved, stage: saved.stage === 'verified' ? 'verified' : rejected && !saved.signature ? 'cancelled' : 'unknown',
          walletAttempt: { ...saved.walletAttempt, outcome: rejected ? 'rejected' : 'error', responseAt: new Date().toISOString(), ...details },
        });
      }
      throw error;
    });
    await boundedWalletCall(pending);
    }
  } catch (error) {
    const rejected = walletErrorDetails(error).errorCategory === 'user-rejected';
    if (error?.code === 'WALLET_TIMEOUT') persist({ ...operation, stage: 'unknown', walletAttempt: {
      ...operation.walletAttempt, timeoutAt: new Date().toISOString(),
    } });
    if (rejected) { report(operation); return; }
    message(error?.code === 'WALLET_TIMEOUT' ? 'Кошелёк пока не ответил. Проверяю сохранённый адрес NFT…' : selectedWallet.route === 'custom-rpc' ? error.message : 'Кошелёк сообщил об ошибке. Проверяю сохранённый адрес NFT…');
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
      const walletAttempt = publicWalletAttempt(saved.walletAttempt);
      const preparation = publicPreparation(saved.preparation);
      const submission = publicSubmission(saved.submission);
      if (walletAttempt) publicOperation.walletAttempt = walletAttempt;
      if (preparation) publicOperation.preparation = preparation;
      if (submission) publicOperation.submission = submission;
    } catch { unreadable = true; }
  }
  const httpStatus = /RPC HTTP (\d{3}):/.exec($('status').textContent)?.[1];
  // Wallet error messages can contain arbitrary text. Diagnostics use fixed
  // labels instead of copying those messages or a provider URL/API key.
  const status = httpStatus ? `RPC HTTP ${httpStatus}` : unreadable ? 'Не удалось прочитать сохранённую операцию' : busy ? 'Проверка выполняется' : ready ? 'Devnet доступен' : 'См. состояние операции и сообщение на странице';
  return JSON.stringify({
    exportedAt: new Date().toISOString(), page: location.origin + '/devnet/',
    appVersion: 'devnet-20260922-6', operation: publicOperation, storageError: unreadable,
    rpc: endpoint === publicEndpoint ? 'public-devnet' : 'custom-devnet',
    rpcProvider: endpoint === publicEndpoint ? 'solana-public' : new URL(endpoint).hostname === 'devnet.helius-rpc.com' ? 'helius' : 'other',
    walletConnected: Boolean(wallet), ownerConnected: wallet?.address === S.owner,
    walletRoute: wallet ? wallet.route === 'custom-rpc' ? 'custom-rpc' : 'wallet' : 'none',
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
window.addEventListener('pagehide', () => { ++walletGeneration; wallet?.off(); wallet = null; ready = false; render(); });
loadSaved(); render();
updateWalletOptions();
subscribeWallets(updateWalletOptions);
if (operation && !storageError) report(operation);
// No automatic wallet prompts, signing, resubmission, or polling after reload.
