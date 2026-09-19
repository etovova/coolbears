import { base58 } from '@metaplex-foundation/umi/serializers';
import { assertDevnet } from './builders.mjs';

export async function sendTracked(umi, builder, state, persist, pending, commit) {
  assertDevnet(umi);
  if (state.pending) throw new Error('Предыдущая операция ещё проверяется. Нажми «Проверить состояние».');
  if (umi.identity.publicKey !== state.owner) throw new Error('Кошелёк сменился. Подключись заново.');
  if (!builder.fitsInOneTransaction(umi)) throw new Error('Транзакция превышает размер Solana. Ничего не отправлено.');
  const blockhash = await umi.rpc.getLatestBlockhash();
  const signed = await builder.setBlockhash(blockhash).buildAndSign(umi);
  const signature = signed.signatures[0];
  if (!signature || signature.length !== 64 || !signature.some(byte => byte !== 0)) throw new Error('Кошелёк не подписал транзакцию.');
  const signatureText = base58.deserialize(signature)[0];
  commit?.();
  state.pending = { ...pending, signature: signatureText, lastValidBlockHeight: Number(blockhash.lastValidBlockHeight) };
  state.transactions ||= [];
  if (!state.transactions.includes(signatureText)) state.transactions.push(signatureText);
  // Persist the signed transaction's identity BEFORE broadcasting. A lost RPC
  // response must not lose the only way to distinguish success from expiry.
  persist(state);
  await umi.rpc.sendTransaction(signed);
  const confirmation = await umi.rpc.confirmTransaction(signature, {
    strategy: { type: 'blockhash', ...blockhash }, commitment: 'confirmed'
  });
  if (confirmation.value.err) throw new Error(`Транзакция отклонена сетью: ${JSON.stringify(confirmation.value.err)}`);
  delete state.pending;
  persist(state);
}

export async function canDiscardPending(rpc, pending) {
  // Legacy backups without a signature cannot prove a failed send. Keep them
  // blocked until the account reads establish the operation's outcome.
  if (!pending.signature || !Number.isSafeInteger(pending.lastValidBlockHeight)) return false;
  const slot = await rpc.call('getSlot', [{ commitment: 'finalized' }]);
  const height = await rpc.call('getBlockHeight', [{ commitment: 'finalized', minContextSlot: slot }]);
  const response = await rpc.call('getSignatureStatuses', [[pending.signature], { searchTransactionHistory: true }]);
  if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(height) || !Number.isSafeInteger(response?.context?.slot) || response.context.slot < slot || !Array.isArray(response.value) || response.value.length !== 1) return false;
  const status = response.value[0];
  if (status === null) return height > pending.lastValidBlockHeight;
  // Even after expiry, a successful signature must wait for account reads.
  // A merely processed/confirmed error can still be on a discarded fork.
  return status?.confirmationStatus === 'finalized' && status.err != null;
}
