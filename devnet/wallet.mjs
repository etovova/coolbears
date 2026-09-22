import { getWallets } from '@wallet-standard/app';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { VersionedTransaction } from '@solana/web3.js';
import { requireValue, isSignature } from './core.mjs';
import { phantomBrowseUrl, solflareBrowseUrl, backpackBrowseUrl } from '../wallet-core.mjs';

const CHAIN = 'solana:devnet';
const SEND = 'solana:signAndSendTransaction';
const OPTIONS = Object.freeze({ preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5 });
const ids = new WeakMap();
let nextId = 0;
const idFor = wallet => { if (!ids.has(wallet)) ids.set(wallet, `standard:${++nextId}`); return ids.get(wallet); };

function compatible(wallet) {
  return wallet?.chains?.includes(CHAIN) &&
    typeof wallet.features?.['standard:connect']?.connect === 'function' &&
    typeof wallet.features?.['standard:events']?.on === 'function' &&
    typeof wallet.features?.[SEND]?.signAndSendTransaction === 'function' &&
    wallet.features[SEND].supportedTransactionVersions?.includes(0);
}
function injected(scope) {
  return [
    { id: 'injected:phantom', name: 'Phantom', provider: scope.phantom?.solana },
    { id: 'injected:solflare', name: 'Solflare', provider: scope.solflare },
  ].filter(({ provider }) => typeof provider?.connect === 'function' && typeof provider.signAndSendTransaction === 'function');
}

// A name in a catalogue is not a capability check. Offer only wallets which
// advertise the chain, v0 transaction and signing method this page actually uses.
export function getAvailableWallets(scope = globalThis, registry = getWallets()) {
  const standard = registry.get().filter(compatible).map(wallet => ({ id: idFor(wallet), name: wallet.name, kind: 'standard' }));
  return [...standard, ...injected(scope).filter(item => !standard.some(wallet => wallet.name === item.name))
    .map(({ id, name }) => ({ id, name, kind: 'injected' }))];
}

export function subscribeWallets(changed, registry = getWallets()) {
  let closed = false;
  const watched = new Map();
  const refresh = () => {
    if (closed) return;
    for (const [wallet, off] of watched) if (!registry.get().includes(wallet)) { off(); watched.delete(wallet); }
    for (const wallet of registry.get()) {
      if (watched.has(wallet) || typeof wallet.features?.['standard:events']?.on !== 'function') continue;
      const off = wallet.features['standard:events'].on('change', () => { if (!closed) changed(); });
      watched.set(wallet, typeof off === 'function' ? off : () => {});
    }
    changed();
  };
  const offRegister = registry.on('register', refresh);
  const offUnregister = registry.on('unregister', refresh);
  refresh();
  return () => {
    if (closed) return;
    closed = true; offRegister(); offUnregister();
    for (const off of watched.values()) off();
    watched.clear();
  };
}

// Call synchronously from a user click so mobile browsers retain user activation.
// Never propagate search parameters, fragments, user info or RPC credentials.
export function walletConnectionAction(name, scope = globalThis, pageUrl = scope.location?.href, registry = getWallets()) {
  if (getAvailableWallets(scope, registry).some(wallet => wallet.name === name || wallet.id === name)) return { type: 'connect' };
  const mobile = /Android|iPhone|iPad|iPod/i.test(scope.navigator?.userAgent || '') ||
    (scope.navigator?.platform === 'MacIntel' && scope.navigator?.maxTouchPoints > 1);
  const browse = name === 'Phantom' ? phantomBrowseUrl : name === 'Solflare' ? solflareBrowseUrl : name === 'Backpack' ? backpackBrowseUrl : null;
  if (mobile && browse) {
    const page = new URL(pageUrl);
    if (page.protocol === 'https:') return { type: 'browse', url: browse(new URL('/devnet/', page.origin).href) };
  }
  return { type: 'unavailable', message: `Открой страницу внутри ${name} или установи его расширение` };
}

function addressIsValid(address) {
  try { return typeof address === 'string' && base58.serialize(address).length === 32; }
  catch { return false; }
}
function usableAccount(account) {
  return addressIsValid(account?.address) && account.chains?.includes(CHAIN) && account.features?.includes(SEND) &&
    account.publicKey instanceof Uint8Array && account.publicKey.length === 32 && base58.deserialize(account.publicKey)[0] === account.address;
}

// Timeout only limits connecting, which cannot submit a transaction. Signing is
// deliberately not raced here: the application must retain late signatures.
function waitForConnection(connect, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); callback(value);
    };
    const aborted = () => finish(reject, new DOMException('Подключение кошелька отменено', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('Кошелёк не ответил вовремя. Закрой запрос подключения в кошельке и попробуй снова.')), timeoutMs);
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    try { Promise.resolve(connect()).then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

export async function connectWallet(selection, changed = () => {}, scope = globalThis, { signal, timeoutMs = 60000, registry = getWallets() } = {}) {
  requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Неверное время ожидания кошелька');
  const requested = typeof selection === 'string' ? selection : selection?.id;
  const available = getAvailableWallets(scope, registry);
  const matches = available.filter(wallet => wallet.id === requested || wallet.name === requested);
  requireValue(matches.length <= 1, 'Найдено несколько кошельков с этим именем. Выбери кошелёк из списка.');
  const selected = matches[0];
  requireValue(selected, `Открой страницу внутри ${typeof selection === 'string' ? selection : selection?.name || 'кошелька'} или установи его расширение`);
  let active = false;
  const cleanup = [];
  const off = () => { active = false; for (const stop of cleanup.splice(0)) stop(); };
  const invalidate = () => { if (active) { off(); changed(); } };

  try {
    if (selected.kind === 'standard') {
      const standard = registry.get().find(wallet => idFor(wallet) === selected.id);
      const result = await waitForConnection(() => standard.features['standard:connect'].connect(), { signal, timeoutMs });
      requireValue(registry.get().includes(standard) && compatible(standard), 'Кошелёк стал недоступен. Подключись снова.');
      const returned = result?.accounts?.find(usableAccount);
      requireValue(returned, 'Включи Devnet в настройках кошелька и подключись снова');
      const account = standard.accounts?.find(item => item.address === returned.address && usableAccount(item));
      requireValue(account, 'Кошелёк сменил аккаунт. Подключись снова.');
      const stop = standard.features['standard:events'].on('change', properties => {
        if (!properties || ['accounts', 'chains', 'features'].some(key => key in properties)) invalidate();
      });
      requireValue(typeof stop === 'function', 'Кошелёк не поддерживает отключение слушателя');
      cleanup.push(stop, registry.on('unregister', (...wallets) => { if (wallets.includes(standard)) invalidate(); }));
      active = true;
      return {
        id: selected.id, name: selected.name, transport: 'standard', address: account.address, off,
        async send(bytes) {
          requireValue(active && registry.get().includes(standard) && compatible(standard), 'Кошелёк изменился. Подключись снова.');
          const current = standard.accounts?.find(item => item.address === account.address && usableAccount(item));
          requireValue(current, 'Кошелёк сменил аккаунт');
          const [result] = await standard.features[SEND].signAndSendTransaction({ account: current, chain: CHAIN, transaction: bytes, options: OPTIONS });
          requireValue(result?.signature instanceof Uint8Array && result.signature.length === 64 && result.signature.some(Boolean), 'Кошелёк не вернул подпись; проверь результат');
          const signature = base58.deserialize(result.signature)[0];
          requireValue(isSignature(signature), 'Кошелёк не вернул подпись; проверь результат');
          return signature;
        },
      };
    }

    const { provider } = injected(scope).find(wallet => wallet.id === selected.id);
    const result = await waitForConnection(() => provider.connect(), { signal, timeoutMs });
    const address = (result?.publicKey || provider.publicKey)?.toString();
    requireValue(addressIsValid(address), 'Кошелёк не вернул адрес');
    requireValue(provider.publicKey?.toString() === address, 'Кошелёк сменил аккаунт. Подключись снова.');
    const remove = provider.removeListener || provider.off;
    requireValue(typeof provider.on === 'function' && typeof remove === 'function', 'Кошелёк не поддерживает события аккаунта');
    for (const event of ['accountChanged', 'disconnect']) {
      provider.on(event, invalidate);
      cleanup.push(() => remove.call(provider, event, invalidate));
    }
    active = true;
    return {
      id: selected.id, name: selected.name, transport: 'injected', address, off,
      async send(bytes) {
        requireValue(active && provider.publicKey?.toString() === address, 'Кошелёк сменил аккаунт');
        const result = await provider.signAndSendTransaction(VersionedTransaction.deserialize(bytes), OPTIONS);
        requireValue(isSignature(result?.signature), 'Кошелёк не вернул подпись; проверь результат');
        return result.signature;
      },
    };
  } catch (error) { off(); throw error; }
}
