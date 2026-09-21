import { getWallets } from '@wallet-standard/app';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { VersionedTransaction } from '@solana/web3.js';
import { requireValue, isSignature } from './core.mjs';

export async function connectWallet(name, changed, scope = window) {
  const standard = getWallets().get().find(wallet => wallet.name === name && wallet.features['solana:signAndSendTransaction']?.supportedTransactionVersions?.includes(0) && typeof wallet.features['standard:connect']?.connect === 'function' && typeof wallet.features['standard:events']?.on === 'function');
  const options = { preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5 };
  if (standard) {
    const { accounts } = await standard.features['standard:connect'].connect();
    const account = accounts.find(item => item.chains.includes('solana:devnet') && item.features.includes('solana:signAndSendTransaction'));
    requireValue(account, 'Включи Devnet в настройках кошелька и подключись снова');
    const off = standard.features['standard:events'].on('change', () => changed());
    return {
      address: account.address, off,
      async send(bytes) {
        requireValue(standard.accounts.some(item => item.address === account.address), 'Кошелёк сменил аккаунт');
        const [result] = await standard.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain: 'solana:devnet', transaction: bytes, options });
        const signature = base58.deserialize(result.signature)[0];
        requireValue(isSignature(signature), 'Кошелёк не вернул подпись; проверь результат');
        return signature;
      },
    };
  }
  const provider = name === 'Phantom' ? scope.phantom?.solana : scope.solflare;
  requireValue(provider && typeof provider.signAndSendTransaction === 'function', `Открой страницу внутри ${name} или установи его расширение`);
  const result = await provider.connect();
  const address = (result?.publicKey || provider.publicKey)?.toString();
  requireValue(address, 'Кошелёк не вернул адрес');
  provider.on?.('accountChanged', changed);
  provider.on?.('disconnect', changed);
  return {
    address, off() { provider.removeListener?.('accountChanged', changed); provider.removeListener?.('disconnect', changed); },
    async send(bytes) {
      requireValue(provider.publicKey?.toString() === address, 'Кошелёк сменил аккаунт');
      const result = await provider.signAndSendTransaction(VersionedTransaction.deserialize(bytes), options);
      requireValue(isSignature(result?.signature), 'Кошелёк не вернул подпись; проверь результат');
      return result.signature;
    },
  };
}
