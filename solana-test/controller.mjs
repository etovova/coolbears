import { createWalletUI } from '../wallet-ui.mjs?v=wallets-20260919';
const $ = id => document.getElementById(id);
const KEY = 'coolbears-solana-devnet-20260918';
let state, client, current, busy = false;
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { state = {}; }
const persist = next => { state = next; localStorage.setItem(KEY, JSON.stringify(next)); };
const wallet = createWalletUI({ language: () => 'ru', onChange: address => {
  client = null; current = null;
  $('account').textContent = address || 'Кошелёк не подключён.';
  $('connect').textContent = address ? 'Отключить кошелёк' : 'Подключить кошелёк';
  render();
} });
function render() {
  $('connect').disabled = busy;
  $('restore').disabled = busy;
  $('refresh').disabled = busy || !wallet.address;
  const ready = !busy && Boolean(client) && Number.isFinite(current?.balance) && current.balance > 0 && !state.pending;
  $('createCollection').disabled = !ready || Boolean(state.collection);
  $('createMachine').disabled = !ready || !current?.collection || Boolean(state.machine);
  $('loadItems').disabled = !ready || !current?.machine || current.machine.itemsLoaded === 2;
  $('mint').disabled = !ready || current?.machine?.itemsLoaded !== 2 || current.machine.itemsRedeemed >= 2n;
  $('mint').textContent = `4. Получить тестовый #${String(current?.machine?.itemsRedeemed || 0).padStart(4, '0')}`;
}
async function connectClient() {
  if (!wallet.provider || !wallet.address) throw new Error('Подключи кошелёк.');
  if (!client) {
    const { ownerClient } = await import('./sdk.js?v=blockhash-20260919');
    client = ownerClient(wallet.provider, state, persist);
  }
}
async function refresh() {
  current = null;
  await connectClient();
  current = await client.read();
  const lines = [`DEVNET · Баланс: ${current.balance.toLocaleString('ru-RU', { maximumFractionDigits: 9 })} тестовых SOL`];
  if (current.balance === 0) lines.push('Сначала получи тестовые SOL по ссылке выше, затем нажми «Проверить состояние».');
  if (state.collection) lines.push(`Коллекция: ${state.collection}`, current.collection ? 'Коллекция подтверждена · роялти 7%' : 'Создание коллекции не подтверждено.');
  if (state.machine) lines.push(`Минт: ${state.machine}`, `Подготовлено: ${current.machine?.itemsLoaded || 0}/2 · Выпущено: ${current.machine?.itemsRedeemed || 0}/2`);
  if (state.pending) lines.push('Операция ожидает подтверждения. Нажми «Проверить состояние» позже.');
  $('chain').textContent = lines.join('\n');
  $('assets').replaceChildren();
  for (const asset of current.assets) {
    const li = document.createElement('li'), a = document.createElement('a');
    a.textContent = `${asset.name} · владение подтверждено`;
    a.href = `https://explorer.solana.com/address/${asset.publicKey}?cluster=devnet`;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); $('assets').append(li);
  }
}
function transactionMessage(error, pending) {
  if (error.code === 4001 || error.name === 'AbortError') return 'Действие отменено в кошельке.';
  if (/blockhash not found|block height exceeded|blockhash.*expired/i.test(error.message || '')) {
    return pending
      ? 'Сеть не приняла или не подтвердила транзакцию вовремя. Нажми «Проверить состояние». Если срок ещё не истёк, повтори проверку через минуту. Новая попытка станет доступна после проверки.'
      : 'Кошелёк не смог проверить свежесть транзакции. Убедись, что в кошельке выбрана Solana Devnet, затем повтори действие и подтверди новую транзакцию.';
  }
  return error.message || 'Не удалось выполнить операцию. Нажми «Проверить состояние».';
}
async function run(action) {
  if (busy) return;
  busy = true; render(); $('status').textContent = 'Выполняется…';
  try { await action(); $('status').textContent = ''; }
  catch (error) { $('status').textContent = transactionMessage(error, state.pending); }
  finally { busy = false; render(); }
}
$('connect').onclick = () => run(async () => {
  if (wallet.address) await wallet.disconnect();
  else { await wallet.connect(); await refresh(); }
});
$('refresh').onclick = () => run(refresh);
for (const name of ['createCollection', 'createMachine', 'loadItems', 'mint']) {
  $(name).onclick = () => run(async () => { await connectClient(); await client[name](); await refresh(); });
}
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'CoolBears_Solana_Devnet_Result.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('restore').onchange = () => run(async () => {
  const file = $('restore').files[0]; if (!file) return;
  if (file.size > 100000) throw new Error('Слишком большой файл.');
  const value = JSON.parse(await file.text());
  const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (value.cluster !== 'devnet' || !address.test(value.owner || '') || (value.collection && !address.test(value.collection)) || (value.machine && !address.test(value.machine)) || !Array.isArray(value.assets) || value.assets.length > 2 || value.assets.some(a => !address.test(a))) throw new Error('Это не результат CoolBears Devnet.');
  persist(value); client = null; current = null;
  if (wallet.address) await refresh();
});
render();
