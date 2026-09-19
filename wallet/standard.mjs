import { getWallets } from '@wallet-standard/app';
import { StandardWalletAdapter } from '@solana/wallet-standard-wallet-adapter-base';
const adapters = new WeakMap();
export function compatible(wallet) {
  const f = wallet.features || {};
  return wallet.chains?.includes('solana:devnet') && typeof f['standard:connect']?.connect === 'function' && typeof f['standard:events']?.on === 'function' && typeof f['solana:signTransaction']?.signTransaction === 'function' && f['solana:signTransaction'].supportedTransactionVersions?.includes('legacy');
}
export function standardOptions(wallets = getWallets().get()) {
  return wallets.filter(compatible).map(wallet => {
    let adapter = adapters.get(wallet);
    if (!adapter) { adapter = new StandardWalletAdapter({ wallet }); adapters.set(wallet, adapter); }
    return { name: wallet.name, provider: adapter };
  });
}
export function watchStandard(callback) {
  const registry = getWallets();
  const off = [registry.on('register', callback), registry.on('unregister', callback)];
  return () => off.forEach(fn => fn());
}
