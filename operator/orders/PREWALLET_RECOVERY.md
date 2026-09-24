# Positive finalized recovery before a local wallet claim

An existing native signing claim may have no durable partial, or a partial may
exist without a wallet claim. This adapter can close the attempt only if a bounded
read-only search finds the exact finalized transaction and independently verifies
its outcome. It does not reconstruct a missing native result for signing or make
an unsigned order eligible to retry. In the ordinary local protocol, a transaction
with truly lost native bytes cannot have been sent; an empty search therefore
remains unknown. Positive recovery accommodates a matching transaction already
observed outside the incomplete local history without inventing its provenance.

`createBuyerPrewalletRecovery({storage,scope,transport}).recover()` uses
`readPrewalletRecovery`, `recoverPrewallet` and `savePrewalletRecovery`. The server
route is `/api/buyer/recover-prewallet`, with exact `order`, `claim`, `request`
fields (`request:null` is allowed). It accepts only the last existing attempt in
`wallet-pending` with no signature, matching the original SDK unsigned native
claim. It has the same closed owner-only Devnet policy, origin checks, quotas and
RPC limits as the existing gateway. The generated sender remains disabled.

The saved preparation anchor is mandatory; attempt two also requires the genuine
first terminal record and acknowledged replacement. Discovery reads at most ten
finalized asset-address history rows. Empty history, a full ten-row page, invalid
ordering, duplicates, nonfinalized rows, malformed receipts, conflicting evidence
or no exact message match produce unknown with no response bytes or retry grant.
Both signatures must verify over the exact original unsigned message. A saved
partial must match the observed native signature. The existing receipt verifier
then checks independent finalized status/full bytes and the Core asset, or final
failure plus paid fee/balance evidence. All discovery and receipt reads share a
30-second monotonic deadline. There is no broadcast or transaction-signing call.

The verifier's ephemeral unknown/signature projection is not persisted as wallet
history. On success the gateway transaction writes one permanent
`buyer-prewallet-recovery:v1:` record containing claim hash, exact observed bytes,
proof and failure evidence when applicable. Competing terminal/send records or a
changed preparation anchor block the write. Readback precedes the response. The
record blocks old checks, sends, expiry and replacement; a failed outcome does
not create the ordinary retry-authorizing failure record. Cached recovery works
after SQLite restart, secret rotation, pause or a later saved matching partial.
If a genuine wallet claim/response wins the local race, existing response/ordinary
recovery can reuse the same cached proof, retaining that actual history.

Under the exclusive order lock, the browser validates full event replay, native
claim, saved partial and CryptoKey possession. It adds only one `reconcile` event
and one `prewallet-recovered` signing row (key phase index 6) in a strict transaction
with the terminal order. No ready row, wallet claim, cost approval, signature event
or send claim is fabricated. CAS checks current revision and all signing rows.
Stale reports after pause, late partial or wallet activity cannot overwrite data.
Post-commit validation exposes the terminal result through `readPrewalletRecovery`
and `readBuyerAttempt(...).prewallet`. Retained native memory is released only
after a validated terminal read, including recovery from lost readback. The
existing sender and wallet adapters cannot use this terminal row to sign or send.

## Coverage and limits

Eight Node cases cover positive bindings, paid failures, genuine second attempts,
thirteen negative history/receipt mutations, input validation, write/drop/ack
faults, corrupt/conflicting cached records, HTTP binding and local acknowledgment.
Five workerd/SQLite cases exercise full restarts, credential rotation, partial
late arrival, lost replies, failures, unknown history and second-attempt recovery.
Twelve Chromium scenarios cover real IndexedDB, native CryptoKeys, HTTPS and
workerd: unprepared order, lost native bytes across restart, saved partial, absent
history, paid failure, transaction abort, lost local acknowledgment/readback,
pause, late partial, genuine wallet race and second-attempt history.

These are disposable local fixtures with intercepted RPC. The synthetic observed
transaction reuses the original fixture native signature and a disposable buyer
key; it is never broadcast. No real wallet, phone, live Devnet or independent RPC
agreement is claimed. The trusted same-origin application/gateway/storage remain
the boundary; normalized evidence is not an independent chain certificate.

No negative-evidence retirement, retry permission, unprepared order recovery,
third attempt, later item, full-order cost approval or purchase UI is added.
Those remain separate work. Existing real journals, custody and locks are kept.

Primary sources checked for the bounded read-only search:
- https://solana.com/docs/rpc/http/getsignaturesforaddress
- https://solana.com/docs/rpc/http/gettransaction

Sales remain closed at 0.2 SOL. No merge, deployment, real wallet signature or
network transaction; Lab 2/2 is not repeated.
