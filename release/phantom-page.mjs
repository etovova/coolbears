import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { Connection } from '@solana/web3.js';
import { standardOptions } from '../wallet/standard.mjs';
import { phantomBrowseUrl } from '../wallet-core.mjs';
import { phantomCheck, DEVNET_GENESIS } from './phantom-flow.mjs';
import { openPhantomStore } from './phantom-store.mjs';
import { createRpcFetch, rpcMessage } from './phantom-rpc.mjs';
import policy from '../metadata/policy.json' with { type: 'json' };

const endpoint = 'https://api.devnet.solana.com';
const $ = id => document.getElementById(id);
const messages = {
  network: 'Проверяю сеть Devnet…', preparing: 'Проверяю баланс и готовлю тестовый NFT…',
  wallet: 'Подтверди создание тестового NFT в Phantom.', confirming: 'Проверяю подтверждение в Devnet…',
};
const errors = {
  WRONG_WALLET: 'Выбери в Phantom кошелёк владельца, указанный на странице.',
  WRONG_NETWORK: 'Проверка остановлена: ответила другая сеть.',
  NEED_TEST_SOL: 'Для теста нужно не менее 0,01 тестового SOL в Devnet.',
  STORAGE_UNAVAILABLE: 'Браузер не разрешает сохранять результат. Открой страницу в обычном режиме браузера Phantom.',
  WALLET_RESULT_UNKNOWN: 'Phantom пока не вернул результат. Нажми «Проверить результат», когда завершишь действие в кошельке.',
  RPC_TIMEOUT: 'Ответ Devnet не получен вовремя. Нажми «Проверить результат» чуть позже.',
  RESULT_STILL_PENDING: 'Результат ещё не определён. Используй «Проверить результат».',
  SIMULATION_FAILED: 'Проверка транзакции в Devnet не прошла. Подпись не запрашивалась.',
};
let store, provider, flow, state, lastError, busy = false;
let detach = () => {};
const rpc = createRpcFetch({ onEvent: event => {
  if (event.type === 'waiting' && event.rateLimited) $('status').textContent = `Сервер попросил паузу. Повторная проверка через ${Math.ceil(event.waitMs / 1000)} с; подпись повторно не запрашивается.`;
  if (event.type === 'request') $('network-status').textContent = 'Проверяю ответ Devnet…';
  if (event.type === 'limited') $('network-status').textContent = 'Ожидаю разрешённое сервером время следующего запроса…';
  if (event.type === 'response' && event.httpStatus === 200 && event.rpcCode === undefined) $('network-status').textContent = 'Сервер Devnet ответил.';
} });
const connection = new Connection(endpoint, { commitment: 'confirmed', fetch: rpc.fetch, disableRetryOnRateLimit: true });
function link(id, type, value) {
  const element = $(id); element.hidden = !value;
  if (value) element.href = `https://explorer.solana.com/${type}/${encodeURIComponent(value)}?cluster=devnet`;
}
function draw() {
  const address = provider?.publicKey?.toString();
  $('connected').textContent = address || 'Не подключён';
  const ready = address === policy.owner && Boolean(flow);
  const retry = ['cancelled', 'expired', 'failed'].includes(state?.phase);
  const cooling = rpc.retryAt() > Date.now();
  $('connect').disabled = busy || !store;
  $('connect').textContent = ready ? 'Phantom подключён' : 'Подключить Phantom';
  $('create').disabled = busy || cooling || !ready || Boolean(state && !retry);
  $('create').textContent = retry ? 'Повторить тест' : 'Создать тестовый NFT';
  $('check').disabled = busy || cooling || !ready || !state;
  $('network-check').disabled = busy || cooling;
  $('copy').disabled = false;
  $('asset').textContent = state?.asset || 'Ещё не создан';
  link('asset-link', 'address', state?.asset);
  link('signature-link', 'tx', state?.signature);
}
function showResult() {
  const text = {
    verified: 'Готово: NFT подтверждён в Devnet и принадлежит твоему кошельку. Теперь проверь его отображение в Phantom.',
    cancelled: 'Подпись отменена. Можно повторить тест.',
    expired: 'Срок транзакции истёк; отсутствие NFT проверено в Devnet. Можно повторить тест.',
    failed: 'Сеть отклонила транзакцию. NFT не создан; можно повторить тест.',
    submitted: 'Подпись сохранена. Окончательное подтверждение ещё ожидается — нажми «Проверить результат».',
    'awaiting-wallet': 'Результат запроса к Phantom ещё не определён. Нажми «Проверить результат».',
  };
  if (state) $('status').textContent = text[state.phase] || 'Сохранена незавершённая попытка. Проверь результат.';
}
async function action(task) {
  if (busy) return;
  busy = true; draw();
  try { await task(); }
  catch (error) {
    if (store) state = await store.load().catch(() => state);
    const text = String(error.message || error);
    const code = error.code || text.match(/RPC_[A-Z_]+/)?.[0];
    lastError = { at: new Date().toISOString(), code: code || 'CHECK_FAILED', method: error.method,
      message: text.slice(0, 220), hasSavedIntent: Boolean(state) };
    $('status').textContent = rpcMessage(code, Boolean(state)) || errors[error.message] ||
      (text.includes('429') ? rpcMessage('RPC_RATE_LIMIT', Boolean(state)) :
      `Проверка остановлена: ${String(error.message || error).slice(0, 220)}. Сохранённую попытку можно проверить повторно.`);
    $('network-status').textContent = 'Диагностику можно скопировать ниже.';
  } finally { if (store) state = await store.load().catch(() => state); busy = false; draw(); }
}
let wasCooling = false;
setInterval(() => {
  const seconds = Math.ceil((rpc.retryAt() - Date.now()) / 1000);
  if (seconds > 0) { wasCooling = true; $('network-status').textContent = `Следующий запрос разрешён через ${seconds} с.`; }
  else if (wasCooling) { wasCooling = false; $('network-status').textContent = 'Пауза закончилась. Можно проверить связь.'; }
  draw();
}, 1000);
$('network-check').onclick = () => action(async () => {
  $('status').textContent = 'Проверяю связь с Devnet. Подпись не требуется.';
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw Error('WRONG_NETWORK');
  lastError = null;
  $('network-status').textContent = 'Связь с Devnet работает.';
  $('status').textContent = state ? 'Связь есть. Подключи Phantom, если он ещё не подключён, и проверь сохранённый результат.'
    : 'Связь с Devnet работает. Подключи Phantom, если он ещё не подключён, затем нажми «Создать тестовый NFT».';
});
function changed() { flow = null; draw(); $('status').textContent = 'Кошелёк изменён или отключён. Нажми «Подключить Phantom».'; }
$('connect').onclick = () => action(async () => {
  $('status').textContent = 'Подключи кошелёк в Phantom…';
  const standard = standardOptions().find(option => option.name === 'Phantom')?.provider;
  const next = standard || (window.phantom?.solana?.isPhantom ? window.phantom.solana : null);
  if (!next) { $('status').textContent = 'Открой эту страницу через кнопку «Открыть в Phantom» или установи расширение Phantom на компьютере.'; return; }
  detach();
  provider = next;
  const noop = () => {};
  provider.on?.('error', noop);
  provider.on?.('accountChanged', changed); provider.on?.('connect', changed); provider.on?.('disconnect', changed);
  detach = () => { for (const [event, handler] of [['error', noop], ['accountChanged', changed], ['connect', changed], ['disconnect', changed]]) provider?.removeListener?.(event, handler); };
  await provider.connect();
  if (provider.publicKey?.toString() !== policy.owner) throw Error('WRONG_WALLET');
  if (provider.standard) {
    const account = provider.wallet.accounts.find(account => account.address === policy.owner);
    if (!account?.chains.includes('solana:devnet') || !account.features.includes('solana:signAndSendTransaction')) {
      throw Error('Включи Testnet Mode → Solana Devnet в настройках Phantom и подключись повторно');
    }
  } else if (typeof provider.signAndSendTransaction !== 'function') throw Error('Обнови приложение Phantom');
  const wallet = provider;
  const umi = createUmi(connection).use(mplCore());
  flow = phantomCheck({ umi, wallet, store, readHeight: async () => {
      const info = await connection.getEpochInfo('finalized');
      return { blockHeight: info.blockHeight, slot: info.absoluteSlot };
    },
    progress: step => { $('status').textContent = messages[step]; },
    send: async transaction => {
      const options = { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 };
      if (wallet.standard) return wallet.sendTransaction(transaction, connection, options);
      return (await wallet.signAndSendTransaction(transaction, options)).signature;
    },
  });
  $('status').textContent = 'Phantom подключён. Можно создать один тестовый NFT или проверить сохранённую попытку.';
});
$('create').onclick = () => action(async () => {
  state = await (state ? flow.retry() : flow.start()); showResult();
});
$('check').onclick = () => action(async () => { state = await flow.check(); showResult(); });
$('copy').onclick = async () => {
  const report = JSON.stringify({ page: 'phantom-check-v2', network: 'devnet', wallet: provider?.publicKey?.toString(),
    savedIntent: Boolean(state), lastError: lastError || null, rpc: rpc.diagnostics(), ...state }, null, 2);
  try { await navigator.clipboard.writeText(report); $('status').textContent = 'Результат скопирован. Его можно прислать в чат.'; }
  catch { $('diagnostic').hidden = false; $('diagnostic').value = report; $('diagnostic').focus(); $('diagnostic').select(); }
};
$('open-phantom').href = phantomBrowseUrl(`${policy.website}/phantom-check/`);
$('owner').textContent = policy.owner;
try {
  store = await openPhantomStore(policy.owner); state = await store.load();
  $('status').textContent = state ? 'Сохранена предыдущая попытка. Подключи Phantom и проверь результат.' : 'Начни с подключения Phantom.';
} catch { $('status').textContent = errors.STORAGE_UNAVAILABLE; }
draw();
