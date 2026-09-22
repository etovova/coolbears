import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { settings as S } from './settings.mjs';

// Only the local signature verifier is used. Constructing Umi makes no RPC
// request and this module never creates a signer, signs, or submits anything.
const eddsa = createUmi(S.rpc).eddsa;
const PACKET_LIMIT = 1232;
const sameBytes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
function requireSigned(condition, message) {
  if (!condition) throw Object.assign(Error(message), { code: 'SIGNED_TRANSACTION_INVALID' });
}
function publicAddress(value) {
  requireSigned(typeof value === 'string', 'Не совпадают адреса подписываемой операции. Отправка остановлена.');
  try { requireSigned(new PublicKey(value).toBase58() === value, 'Некорректный адрес операции. Отправка остановлена.'); }
  catch { throw Object.assign(Error('Некорректный адрес операции. Отправка остановлена.'), { code: 'SIGNED_TRANSACTION_INVALID' }); }
  return value;
}
function canonicalTransaction(input) {
  requireSigned(input instanceof Uint8Array && input.length > 0 && input.length <= PACKET_LIMIT, 'Некорректный размер транзакции. Отправка остановлена.');
  const bytes = new Uint8Array(input);
  let transaction, canonical;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
    canonical = transaction.serialize();
  } catch {
    throw Object.assign(Error('Не удалось прочитать подписанную транзакцию. Отправка остановлена.'), { code: 'SIGNED_TRANSACTION_INVALID' });
  }
  requireSigned(transaction.version === 0, 'Требуется транзакция Solana v0. Отправка остановлена.');
  requireSigned(sameBytes(bytes, canonical), 'Изменился формат транзакции. Отправка остановлена.');
  return { transaction, bytes: canonical };
}

// The application uses the default owner. The explicit expectedOwner option
// permits offline tests with their own generated signers, never the user key.
export function validateSignedTransaction(preparedBytes, signedBytes, operation, { expectedOwner = S.owner } = {}) {
  const owner = publicAddress(expectedOwner);
  requireSigned(operation?.owner === owner, 'Не совпадает владелец операции. Отправка остановлена.');
  const asset = publicAddress(operation.asset);
  const blockhash = publicAddress(operation.blockhash);
  requireSigned(asset !== owner, 'Не совпадает адрес NFT. Отправка остановлена.');
  const prepared = canonicalTransaction(preparedBytes);
  const signed = canonicalTransaction(signedBytes);
  for (const { transaction } of [prepared, signed]) {
    const { message, signatures } = transaction;
    requireSigned(message.header.numRequiredSignatures === 2 && message.header.numReadonlySignedAccounts === 0 && signatures.length === 2, 'Изменились подписанты транзакции. Отправка остановлена.');
    requireSigned(message.staticAccountKeys[0]?.toBase58() === owner && message.staticAccountKeys[1]?.toBase58() === asset, 'Не совпадают плательщик или NFT. Отправка остановлена.');
    requireSigned(message.recentBlockhash === blockhash, 'Изменился срок подписываемой транзакции. Отправка остановлена.');
    requireSigned(signatures.every(signature => signature instanceof Uint8Array && signature.length === 64), 'Некорректные подписи транзакции. Отправка остановлена.');
  }
  const message = prepared.transaction.message.serialize();
  requireSigned(sameBytes(message, signed.transaction.message.serialize()), 'Кошелёк изменил содержимое транзакции. Отправка остановлена.');
  requireSigned(prepared.transaction.signatures[0].every(byte => byte === 0), 'Подготовленная транзакция уже содержит подпись владельца. Отправка остановлена.');
  requireSigned(sameBytes(prepared.transaction.signatures[1], signed.transaction.signatures[1]), 'Изменилась подпись NFT. Отправка остановлена.');
  for (const [index, address] of [owner, asset].entries()) {
    const signature = signed.transaction.signatures[index];
    let valid = false;
    try { valid = signature.some(Boolean) && eddsa.verify(message, signature, address); } catch { /* Invalid signatures fail closed. */ }
    requireSigned(valid, 'Не удалось проверить подписи транзакции. Отправка остановлена.');
  }
  return { bytes: signed.bytes, signature: base58.deserialize(signed.transaction.signatures[0])[0] };
}
