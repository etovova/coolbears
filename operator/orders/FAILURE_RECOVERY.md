**PR49 update:** [Reviewed replacement after a paid failure](FAILED_REPLACEMENT.md)
adds explicit paid-fee acknowledgment and one second attempt with fresh consent.
Earlier stage-specific limits below describe PR47/PR48 behavior at that time.

# Finalized failure and paid fee recovery — closed Devnet

PR48 extends `sender.recover()` to record a proved failed transaction as a
terminal outcome. It retains the exact signed response, cost approval, custody,
all signing/send claims and previous attempts. No new signing, hash, simulation,
send or replacement is authorized. Sales remain closed at 0.2 SOL.

## Evidence before state changes

The existing closed same-origin `/api/buyer/recover` route independently
validates the saved first-item signed transaction. Attempts one and two are
supported, including a signed response observed on chain without a gateway send
claim. Recovery does not require a fresh cost approval or an original anchor;
it only records the result of those exact signed bytes.

The trusted read orchestrator checks Devnet genesis, historical signature
status and finalized base64 transaction. It reuses the existing
`verifyFinalizedFailedTransaction` verifier: all signed bytes, version zero,
slot/finality and canonical complete error must agree. The deprecated status
field, if present, must agree as well. Only the error digest is returned/saved,
not untrusted provider text or logs.

For this ordinary-hash, no-lookup-table buyer template, transaction metadata
must contain safe integer fee/pre/post balances for every message account.
The fee must be positive, payer debit must equal that fee, all other balances
must be unchanged, and the asset balance must be zero before and after. The
normalized evidence retains actual fee/debit and payer pre/post balances as
decimal lamport strings. It does not assert a refund or zero spending.

The asset must then be absent at finalized context at least as new as the
transaction's finalized slot. The status response context itself may be ahead
of finalized state and is not used as that account-read floor. A final
historical status reread must still confirm the same
failed receipt at context no older than the account read. Typical success is
five read RPCs. Pending/missing/contradictory status, incomplete or unsafe fee
metadata, different bytes, observed asset or changed reread leave `unknown`.
An err=null receipt with no asset is not classified as failed; for example,
a bot-tax-like successful transaction needs a separate policy.

This deliberately strict balance profile may leave some valid failures unknown
when their metadata/effects differ. It does not generalize to durable nonce,
arbitrary transactions, lookup tables or all possible future Solana fee rules.
The bound RPC is trusted; normalized evidence is not an independent consensus
certificate. A current absent account alone can never authorize this outcome.

## Durable server and browser history

Before a failed result reaches the browser, SQLite atomically persists and
reads back `buyer-failure:v1:<stable asset identity>`, with `:attempt:2` for the
second attempt. It contains the exact immutable/request/signed-byte identity,
proof and normalized fee/error evidence. A retained record restores before
quotas/uncertainty holds without new RPC, including after credential rotation
or lost successful reply. Current revision/pause is rebound in the response.

Failed attempts cannot prepare/check/send/review expiry, even if no send claim
existed. Changing order IDs cannot evade the stable asset tombstone. Corrupt
records and contradictory failure+expiry records block restoration. Original
preparation, quotes, expired first-attempt evidence, replacement provenance and
permanent send claims remain intact. No claim is released.

`saveBuyerFailure` atomically writes a `failure-reviewed` row, reconcile event
and failed order in schema-2 IndexedDB. It validates the exact current input
before mutation, replays the event history on read and retains full normalized
evidence. A stale in-flight result cannot overwrite a paused/changed order;
explicit recovery restores server evidence for the current revision while
preserving pause. Aborted writes leave the old order, event and signing rows
together. A lost successful local reply is recognized on reload without new
RPC, wallet invocation, signature or send.

`readBuyerAttempt(scope, 1|2)` retains each attempt's evidence. After a failed
terminal result, `recover()` returns `already-recorded`, outcome `failed` and
the saved `feeLamports`. Explicit send/expiry/replacement remain blocked.
Old strict readers refuse the new terminal row. Real stored data is not migrated
or deleted; tests use isolated browser profiles and disposable SQLite only.

## Validation and remaining scope

Eight Node tests cover linked failure, external/unsent receipt, incomplete and
contradictory evidence, unsafe fees/balances, final reread, write/drop/ack loss,
corrupt/dual terminal records, second-attempt history, HTTP binding and sender
idempotence. Five real workerd/SQLite scenarios and six Chromium integration
scenarios exercise process restarts, atomic write abort, reply loss, pause/CAS,
actual browser custody and first/second attempt history. Network responses,
keys, TLS and storage permission are fixtures. No real-wallet/phone claim.

Retry after this failed outcome remains a separate review requiring retained
failure/paid-fee evidence and fresh preparation/consent. PR47 replacement still
accepts only its proved expiry source. Missing wallet responses, unsigned or
partial attempts, later items/full-order consent, custody recovery, purchase UI
and private/live setup remain separate. No merge, deployment or network
transaction is part of this change; generated submission remains disabled.

Primary references checked for this stage:
- https://solana.com/docs/core/transactions
- https://solana.com/docs/rpc/http/gettransaction
- https://solana.com/docs/rpc/http/getsignaturestatuses
- https://solana.com/docs/rpc/json-structures
