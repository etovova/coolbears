// This proof is signed offline. Ledger 1 has already closed on both networks.
export function reservationEnvelope(buyer, message) {
  const memo = Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2,'0')).join('').toUpperCase();
  return {TransactionType:'AccountSet', Account:buyer, Sequence:0, LastLedgerSequence:1,
    Fee:'0', Memos:[{Memo:{MemoData:memo}}]};
}
