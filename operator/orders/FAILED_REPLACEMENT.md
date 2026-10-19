# Reviewed replacement after a paid failure — closed Devnet

PR49 connects the retained PR48 finalized failure to one replacement of the
first item. Sales remain closed at 0.2 SOL; generated submission is disabled.
The original signed bytes, paid fee, approvals and consumed claims stay intact.
No third attempt, automatic retry, deployment or real transaction is enabled.

## Separate acknowledgment and new consent

`sender.prepareReplacement({authorizeReplacement:true,
acknowledgedFeeLamports:"10000"})` requires the exact decimal fee from the
saved first failure. The amount here is an example, not a default. Missing,
numeric, zero, differently formatted or different amounts fail before HTTP.
The existing `/api/buyer/replace` route independently checks it against the
authentic retained failure record before any RPC. An unknown result or a
caller-created failed journal is insufficient. Conflicting expiry/failure
records fail closed.

`store.prepareReplacementSigning(scope, report,
{authorizeReplacementSigning:true, acknowledgedFeeLamports:"10000"})` is a
separate explicit action. It validates the full browser failure record and
the same fee before atomically committing the second native intent. Only then
may the existing non-extractable asset key sign the new bytes once. Generic
append and first-attempt signing cannot bypass the replacement adapter.

The acknowledgment records a fee already paid. It is not a refund, a new
spending allowance or evidence of a physical user gesture. The new wallet
invocation still needs a fresh server quote and explicit cost consent bound
to the second request. Old cost approval cannot authorize the new bytes.
The existing cost cap covers the new attempt; it is not a cumulative order
budget including previous fees. Full-order cost consent remains separate.

## New bytes with retained provenance

Preparation checks Devnet genesis and finalized absence of the asset at or
after the prior failed receipt/account slot. A newer signature-status RPC
context is used as an additional floor for the confirmed blockhash query,
not for the finalized account read. The fresh confirmed source cannot
precede either that floor or the new account read.

The blockhash must differ from the first one. Its last-valid height must
exceed the first attempt's last-valid height and have at least 80 blocks left
at the current confirmed height. This conservative condition does not require
the original hash to expire. A same/stale hash, observed asset, short lifetime
or contradictory RPC context refuses preparation. Four read RPCs create no
signature or send.

The same stable `buyer-replacement:v1:<asset identity>` key holds one record.
Expiry-source records remain version 1 unchanged. Failure-source records are
version 2, containing the full original failure/fee evidence, explicit
`acknowledgedFeeLamports`, fresh anchor, unsigned bytes and a digest covering
all those values. SQLite transaction/readback precedes success; the source
record must still be identical and its opposite terminal record absent at
commit. Older strict readers reject version 2 instead of treating it as expiry.

Lost replies, restart, secret rotation and changed pause/revision restore the
same persisted record without another hash request. Restoring still requires
the exact fee acknowledgment. An already stale saved replacement stays stale.
Second check/send/expiry require that exact record and the unchanged first
failure; a contradictory first expiry blocks them. The first failure cannot
reopen the original prepare/check/send/expiry routes or release its claims.

## Crash recovery and per-attempt history

IndexedDB remains schema 2 with two append-only signing groups. The second
claim retains the complete server replacement record; replay compares its
prior with the original browser failure evidence. Stale results cannot write
over a changed order. Atomic intent-write abort creates no native signature;
loss after signing leaves a consumed unresolved intent, not another signing
opportunity. Both browser and gateway consume independent send claims before
any send. A lost send reply is resolved through finalized recovery.

`readBuyerAttempt(scope, 1|2)` exposes the retained public evidence and fee for
each attempt. A successful second outcome leaves the first failure unchanged.
A second failure records another fee separately; a second expiry keeps its
own expiry evidence. Neither permits a third attempt. Keys are not exported,
recreated or deleted, and real stored orders are not migrated or cleared.

## Verification and remaining work

Seven new Node scenarios cover the linked lifecycle, exact acknowledgment,
missing/corrupt/dual evidence, write/drop/ack faults, pause/rebind, context and
height floors, changing source during RPC, HTTP binding, second failure and
sender behavior. Five real workerd/SQLite scenarios exercise retained source,
restart/credential rotation, fresh consent, successful second recovery and
separate second failure/expiry. Six Chromium scenarios add actual IndexedDB,
native signing, wallet adapter, browser/server restart and atomic write faults.
CI results belong in the PR body and authoritative continuation; all keys,
RPC responses, TLS and storage permissions in tests are disposable fixtures.

The same-origin application, gateway storage and bound RPC remain trusted.
Only attempt two of the first item with a saved fully signed first failure or
expiry is covered. Missing wallet/native responses, partial/unsigned attempts,
later items, cumulative consent, custody recovery, purchase UI and real private
setup/live gates remain separate. PR48 recovery by itself still grants no retry.

Primary references checked for this stage:
- https://solana.com/docs/core/transactions
- https://solana.com/docs/rpc/http/getlatestblockhash
- https://solana.com/docs/rpc/http/getmultipleaccounts
