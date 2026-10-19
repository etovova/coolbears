**PR49 update:** [Reviewed replacement after a paid failure](FAILED_REPLACEMENT.md)
adds explicit paid-fee acknowledgment and one second attempt with fresh consent.
Earlier stage-specific limits below describe PR47/PR48 behavior at that time.

# Reviewed second attempt — closed Devnet

PR47 connects a retained PR46 expiry proof to one replacement of the first item.
Sales remain closed at 0.2 SOL. The generated gateway still disables submission;
this change does not deploy it or invoke a real wallet, RPC or transaction.

## Separate explicit operations

1. `sender.prepareReplacement({authorizeReplacement:true})` requires the first
   fully signed attempt to be recorded as expired, with an unpaused order and no
   later attempts/items. It requests an unsigned template; no signing or send.
2. `store.prepareReplacementSigning(scope, report,
   {authorizeReplacementSigning:true})` independently validates that report and
   the browser's full original expiry evidence. It commits a new native signing
   claim before invoking the existing non-extractable asset key once.
3. The wallet client obtains a fresh server cost quote. Explicit fresh consent
   binds the new request, before its separate wallet claim/sign-only invocation.
4. `sender.sendOnce({authorizeDevnetSend:true})` requires that new saved response
   and cost approval. The browser and gateway consume separate permanent send
   claims for attempt two before network submission. `recover()` verifies the
   exact finalized receipt and Core account and saves attempt two's outcome.

These are application gates, not human-gesture authentication. The same-origin
application and retained gateway storage remain trusted. A caller-created
expired journal cannot replace the server's retained original proof.

## Server record and provenance

`POST /api/buyer/replace` uses the existing exact HTTPS protocol, closed owner
scope, global quotas/lock/spacing and uncertainty holds. It requires explicit
`authorizeReplacement:true` and the original signed input. SQLite must already
contain the matching PR46 expiry identity, full proof and history evidence.

A fresh preparation checks Devnet genesis and the absent asset at finalized
context at least as new as the expiry proof. The confirmed latest-blockhash
query uses that context as its minimum. The new hash must differ, its source
slot cannot precede the old proof, and its last-valid height must exceed the
old proof height by more than 80, with at least 80 blocks remaining at the
new current height. These four RPC reads create no signature or send.

Before replying, the gateway atomically persists and reads back
`buyer-replacement:v1:<stable asset identity>`, containing the complete prior
expiry record, new anchor, unsigned bytes and digest. There is one replacement
record; lost replies, restart, credential rotation or pause/resume return those
same bytes without fetching another hash. Pause/resume can rebind only the
response's current order revision. An already stale saved hash stays stale.

Attempt-two check/send/expiry require an exact match to that retained record
and the original expiry. New send/expiry keys append `:attempt:2`; the first
anchor, expiry tombstone, quotes and send claim are never deleted or released.
Changing an order ID or hash cannot evade the stable asset identity. The fresh
cost quote binds the new request ID, so old consent cannot fund new bytes.

## Browser history and interrupted operations

IndexedDB stays schema 2. Signing rows are grouped by attempt with independent
native, wallet, buyer-response, send and expiry records. Reads replay the whole
event history and verify both groups. The second claim also retains the exact
server replacement record and compares its prior proof with local history.
Generic journal append cannot bypass these adapters once signing rows exist.

Old rows and keys remain unchanged. `readBuyerAttempt(scope, 1|2)` exposes
read-only historical evidence at the appropriate revision, without exporting
private keys or authorizing another signature/send. Normal reads use the latest
attempt. Older strict readers refuse the expanded history.

A claim-write abort rolls back order/event/claim together and performs no
native signature. Once that claim commits, loss of native response persistence
keeps `asset-signing-unknown`; it cannot sign again. Browser/server send claims
remain consumed after any ambiguous response. A lost successful send reply is
resolved by finalized recovery, never by resend. The second attempt may also
be explicitly reviewed as expired with its own anchor and separate tombstone.

## Scope and verification

Only attempt two of item zero after a fully signed, positively reviewed expiry
is implemented. No third attempt, later items, unsigned/partial/missing-wallet
response or finalized-failed replacement is enabled. Full-order spending,
custody recovery policy, purchase UI and real private setup remain separate.
Reports retain `readyToSubmit:false` and `salesOpen:false`.

Local Node tests cover the linked lifecycle, old consent, preserved claims,
lost commit replies, corrupt/missing records, bad RPC contexts, a second expiry
and explicit adapter behavior. The real workerd/SQLite runner covers five
restart/persistence scenarios. The separate Chromium runner covers six linked
browser/HTTPS/workerd scenarios, including native-write failures and old-history
retention. Exact CI results belong in the authoritative continuation/PR body;
the repository checkpoint records only results available at commit time.
All signatures/RPC data are disposable fixtures; no real-wallet/phone claim.

Primary references checked for this stage:
- https://solana.com/docs/rpc/http/getlatestblockhash
- https://solana.com/docs/rpc/http/sendtransaction
