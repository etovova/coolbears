# Missing buyer response recovery — closed Devnet candidate

PR50 extends the saved native-partial + consumed wallet-claim stage. A wallet
may have signed and an external path may have submitted the transaction while
its response was lost. The browser no longer needs those full signed bytes in
memory if the exact transaction can be found and its finalized outcome proved.
This operation creates no signatures, sends no transactions and grants no retry.

`createBuyerResponseRecovery({storage, scope, transport})` exposes the explicit
`recoverMissingResponse()` operation. The transport uses same-origin HTTPS POST
`/api/buyer/recover-response`, with the order, asset claim, saved native request
and consumed wallet claim. It shares the existing nonce, response/body deadlines,
redirect denial and fixed-origin protections. Legacy version-1 wallet claims
are read-only compatible; version-2 historical cost consent remains preserved.

The gateway requires the authentic retained preparation anchor (and, for attempt
two, the existing reviewed replacement and original terminal provenance). It
queries Devnet genesis and finalized asset-address history with a ten-row bound
and the original source-slot floor. An empty page, a full ten-row page, duplicate
or nonfinalized rows, missing transaction, malformed bytes or ambiguity returns
unknown. This bounded lookup never certifies complete history or absence.

Each returned transaction must be canonical version 0, in the row's exact slot.
The saved partial message, native asset signature and full buyer signature must
match; a prior attempt with another message cannot satisfy the lookup. Exactly
one matching candidate proceeds to the existing finalized recovery verifier.
That separately reads signature history, the exact transaction and finalized
Core asset. Success needs the correct owner, collection and hidden metadata.
Failure needs matching error, charged fee and balance evidence, absent asset,
and a stable final signature reread. The discovery row/transaction and final
proof must agree. There is no hash refresh, simulation or send RPC in this path.
All reads are metered under existing durable limits and a shared 30-second
monotonic deadline; provider error bodies never reach the browser.

## Durable result before returning bytes

A new per-asset, per-attempt SQLite record retains native-request identity,
wallet-claim digest, exact signed response and normalized terminal proof. A
failed result also writes the existing complete failure/paid-fee record in the
same transaction. Compare-and-set plus in-transaction and post-commit readbacks
must succeed before a successful response is returned. Existing preparation,
quotes, claims and replacement records are retained. No send claim is invented.

Cached recovery precedes quotas/holds and RPC; full restart, a lost HTTP reply,
credential rotation or changed paused revision can restore the same evidence.
Changed wallet claims, response bytes or contradictory terminal records cannot
rebind it. Prepare/check/send/expiry are permanently blocked for the discovered
attempt. Normal signed-response recovery can consume the cached proof if a late
wallet callback has already saved those bytes. A discovered paid failure can
enter PR49's separate reviewed replacement only with the exact fee acknowledgment,
retained provenance and fresh second-attempt cost consent.

The browser validates the report against its *current* journal under its lock.
One strict IndexedDB transaction commits the recovered signature event, terminal
reconcile event, response row, updated order and (for failure) fee evidence row.
There is never an intermediate sendable response from this recovery adapter.
A write abort rolls everything back. A lost committed local acknowledgment is
handled by reading the already-terminal state without HTTP or signing. Pause is
preserved. A racing late wallet callback is not overwritten: ordinary recovery
can close its identical saved response from the retained server proof. Duplicate
late bytes are idempotent; different bytes conflict.

## Coverage and limits

Seven Node scenarios cover exact discovery, fee/replacement linkage, bounded and
contradictory history, strict input/anchor binding, durable write/ack failures,
record corruption and transport/controller binding. Five actual workerd/SQLite
scenarios cover success, restart/credential rotation, lost failure response,
unknown-to-positive evidence and second-attempt provenance. Eight Chromium
scenarios cover native IndexedDB, browser restart, missing wallet responses,
empty/pending history, lost HTTP/local replies, atomic aborts, paused revisions,
late callbacks and second-attempt recovery after paid failure. Browser reports
and the full exact-head workflow must be inspected before claiming CI success.
All keys, wallet implementations and RPC/receipts in these tests are disposable
fixtures. No real wallets, physical phones, Devnet requests or network submissions.

First item, attempts one/two only. Missing native partial, absent wallet claim,
unsigned attempts, absent/unavailable history and nonfinalized outcomes remain
unresolved. A missing response that was never broadcast cannot be found this
way; it does not receive a new signing opportunity. This is not custody export
or device-loss recovery. Later items, cumulative order consent, purchase UI and
real private setup remain separate. The application, origin, RPC and storage
are trusted; normalized records are not independent chain certificates.

Sales closed, 0.2 SOL. Generated sender remains disabled, nothing deployed.
Lab, real journals/custody/bundles/SQLite/locks, secrets and original art unchanged.

Sources consulted for this specific addition (not a claim of full ecosystem review):
- https://solana.com/docs/rpc/http/getsignaturesforaddress
- https://solana.com/docs/rpc/http/gettransaction
- https://docs.phantom.com/solana/sending-a-transaction
