import { getWallets } from '@wallet-standard/app';
import { createOwnerClient, compatibleOwnerWallet } from './client.mjs';
import { createOwnerStorage } from './storage.mjs';
const $ = id => document.getElementById(id);
const token = location.hash.slice(1), registry = getWallets();
let client, wallets = [], uiBusy = false;
const messages = {
  WALLET_CANCELLED: 'Подпись отменена в кошельке. Транзакция не отправлялась.',
  WRONG_WALLET: 'Выберите кошелёк владельца, указанный в запросе.',
  WALLET_CHANGED: 'Кошелёк изменился. Подключите нужный адрес заново.',
  PREFLIGHT_BLOCKED: 'Свежая проверка не пройдена. Подпись не открыта.',
  WALLET_UNKNOWN: 'Ответ кошелька неизвестен. Повторная подпись заблокирована; требуется проверка сохранённой операции.',
};
function render() {
  if (!client) return;
  const state = client.state();
  if (state.progress) {
    $('progress').max = state.progress.totalSteps; $('progress').value = state.progress.verifiedSteps;
    $('progressText').textContent = `Подтверждено операций: ${state.progress.verifiedSteps} из ${state.progress.totalSteps}. Подпись сама по себе не означает завершение операции.`;
  }
  for (const name of ['deploymentId', 'stepId', 'owner', 'messageSha256']) $(name).textContent = state[name] ?? '—';
  $('sign').disabled = uiBusy || !state.canSign;
  $('recover').hidden = !state.canRecover; $('recover').disabled = uiBusy;
  $('export').hidden = !state.canExport;
  $('connect').disabled = uiBusy || wallets.length === 0 || state.signed;
  $('wallets').disabled = uiBusy; $('reload').disabled = uiBusy;
  $('connected').textContent = state.connected ? `Подключён: ${state.walletName}` : 'Кошелёк не подключён';
  if (state.state === 'verified') $('status').textContent = 'Операция подтверждена и записана в журнал. Следующий шаг подготавливается отдельно.';
  else if (state.state === 'accepted') $('status').textContent = 'Отправка принята RPC. Требуется проверка окончательного результата.';
  else if (['send-claimed', 'unknown'].includes(state.state)) $('status').textContent = 'Результат операции требует проверки. Повторная подпись и отправка заблокированы.';
  else if (['failed', 'expired', 'cancelled'].includes(state.state)) $('status').textContent = 'Попытка закрыта. Новый запрос подготавливается отдельной командой повтора.';
  else if (state.signed) $('status').textContent = 'Подпись сохранена в журнале. Отправка выполняется отдельной командой.';
  else if (state.canRecover) $('status').textContent = 'Ответ кошелька сохранён. Можно повторить его запись в журнал без новой подписи.';
  else if (state.walletRequested || ['wallet-pending', 'unknown'].includes(state.localStatus)) $('status').textContent = 'Запрос уже передан кошельку, результат не сохранён. Повторная подпись заблокирована.';
}
async function action(task) {
  if (uiBusy) return;
  uiBusy = true; $('status').textContent = 'Проверка…'; render();
  try { await task(); $('status').textContent = 'Готово.'; }
  catch (error) { $('status').textContent = messages[error?.code] ?? 'Операция не завершена. Сохранённые данные оставлены для восстановления.'; }
  finally { uiBusy = false; render(); }
}
function showWallets() {
  wallets = registry.get().filter(compatibleOwnerWallet); $('wallets').replaceChildren();
  for (const [index, wallet] of wallets.entries()) { const option = document.createElement('option'); option.value = String(index); option.textContent = wallet.name; $('wallets').append(option); }
  if (!wallets.length) { const option = document.createElement('option'); option.textContent = 'Нужен кошелёк с отдельной подписью Devnet'; $('wallets').append(option); }
  render();
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(40000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error('REQUEST'), { code: value.code });
  return value;
}
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) $('status').textContent = 'Откройте полную локальную ссылку, выданную оператором.';
else {
  client = createOwnerClient({ api, storage: createOwnerStorage(), onChange: render });
  registry.on('register', showWallets); registry.on('unregister', showWallets);
  $('connect').onclick = () => action(() => client.connect(wallets[Number($('wallets').value)]));
  $('sign').onclick = () => action(() => client.sign());
  $('recover').onclick = () => action(() => client.recover());
  $('reload').onclick = () => action(() => client.load());
  $('export').onclick = () => {
    const blob = new Blob([JSON.stringify(client.exportResponse())], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'coolbears-owner-signature.PRIVATE.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  showWallets(); await action(() => client.load());
}
