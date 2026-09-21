import { createWalletUI } from '../wallet-ui.mjs';
import { CoolBearsClient } from '../chain/runtime.mjs';
import { SPEC, validateCommitment } from '../chain/spec.mjs';
import { rpcErrorMessage } from '../chain/rpc.mjs';
const $ = id => document.getElementById(id);
let busy = false, client, release;
const status = text => { $('status').textContent = text; };
const wallet = createWalletUI({ language: () => 'ru', onChange: address => {
  $('wallet').textContent = address;
  client = null; $('create').disabled = busy || address !== SPEC.owner || !release?.verified;
  $('export').disabled = !address;
  $('reveal').disabled = busy || address !== SPEC.owner || Date.now() < SPEC.revealNotBefore * 1000;
  if (address && address !== SPEC.owner) status('Для создания нужен кошелёк владельца CoolBears.');
} });
function connection() {
  if (!wallet.address) throw Error('Сначала подключи кошелёк.');
  if (!client) client = new CoolBearsClient({ provider: wallet.provider, address: wallet.address, endpoint: $('rpc').value, onProgress: status });
  return client;
}
function renderState(state) {
  $('addresses').replaceChildren();
  for (const [name, key] of [['Коллекция', 'collection'], ['Первый NFT', 'reserved'], ['Candy Machine', 'machine']]) {
    if (!state?.[key]) continue;
    const dt = document.createElement('dt'), dd = document.createElement('dd'), link = document.createElement('a');
    dt.textContent = name; link.textContent = state[key].address;
    link.href = `https://explorer.solana.com/address/${state[key].address}?cluster=devnet`; link.target = '_blank'; link.rel = 'noopener noreferrer';
    dd.append(link); $('addresses').append(dt, dd);
  }
}
async function action(fn) {
  if (busy) return; busy = true; $('create').disabled = true; $('connect').disabled = true; $('import').disabled = true; $('rpc').disabled = true; $('reveal').disabled = true;
  try { await fn(); } catch (e) {
    status(e?.code === 4001 ? 'Подпись отменена. Можно продолжить с сохранённого шага.' : rpcErrorMessage(e) || `Операция остановлена. ${e.message}`);
  } finally {
    busy = false; $('connect').disabled = false; $('import').disabled = false; $('rpc').disabled = false;
    $('create').disabled = wallet.address !== SPEC.owner || !release?.verified;
    $('reveal').disabled = wallet.address !== SPEC.owner || Date.now() < SPEC.revealNotBefore * 1000;
    if (client) renderState(client.load());
  }
}
$('rpc').addEventListener('change', () => { client = null; });
$('connect').onclick = () => action(async () => {
  await wallet.connect();
  if (wallet.address !== SPEC.owner) return;
  await connection().checkNetwork(); renderState(connection().load());
  status('Кошелёк владельца подключён. Можно создать выпуск или продолжить сохранённый.');
});
$('create').onclick = () => action(async () => { await connection().deploy(release.commitment); });
$('reveal').onclick = () => action(async () => {
  const c = connection(), state = c.load(), file = $('revealMap').files[0];
  if (!state || !file || file.size > 5000000) throw Error('Нужны состояние выпуска и файл раскрытия до 5 МБ.');
  const count = await c.reveal(state, JSON.parse(await file.text())); status(`Раскрытие подтверждено: ${count} NFT.`);
});
$('export').onclick = () => action(async () => {
  const c = connection(), state = c.load(); if (!state) throw Error('Сначала начни создание коллекции.');
  const body = { state, journal: c.journal.read() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'CoolBears_Deployment_PRIVATE.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Состояние подготовлено для скачивания. Храни файл приватно.');
});
$('import').onchange = () => action(async () => {
  const file = $('import').files[0]; if (!file || file.size > 2000000) throw Error('Выбери файл состояния до 2 МБ.');
  const { state, journal } = JSON.parse(await file.text()), c = connection();
  if (state.schema !== SPEC.schema || state.owner !== SPEC.owner || c.address !== SPEC.owner || state.cluster !== 'devnet' || state.commitment !== release.commitment) throw Error('Файл не соответствует этому выпуску.');
  validateCommitment(state.commitment);
  for (const key of ['collection', 'reserved', 'machine']) c.signer(state[key]);
  const existing = c.load();
  if (existing && existing.collection.address !== state.collection.address) throw Error('В этом браузере уже сохранён другой выпуск.');
  if (journal?.version !== 2 || typeof journal.operations !== 'object') throw Error('Некорректное состояние операций.');
  c.save(state); c.storage.setItem(c.journal.key, JSON.stringify(journal)); renderState(state);
  status('Состояние восстановлено. Перед продолжением каждый шаг будет проверен в сети.');
});
try {
  const response = await fetch('./release.json', { cache: 'no-store' }); if (!response.ok) throw Error('Release unavailable');
  release = await response.json(); validateCommitment(release.commitment);
  $('releaseStatus').textContent = release.verified ? 'Готово: 10 000 изображений и полный цикл выпуска проверены.' : 'Подготовка выпуска продолжается.';
} catch { $('releaseStatus').textContent = 'Подготовка выпуска продолжается.'; }
