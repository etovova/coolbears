# Sequential closed Devnet orders

The buyer adapters can continue a retained order through items 1–50. The next
item becomes eligible only after every earlier item is verified. Preparation,
native signing, a fresh wallet cost approval, wallet signing and the single-use
send claim remain separate stages. No loop automatically invokes a wallet,
sends a transaction, retries a failed attempt or skips an unresolved item.
Sales remain closed at 0.2 SOL; the generated gateway sender remains disabled.

## Order and evidence rules

`sequential.mjs` validates a contiguous verified prefix followed by at most one
attempted item and untouched later items. Each item retains at most two attempts.
An explicit reviewed replacement is possible after the first attempt fails or
expires, using its existing evidence-specific route. Unknown outcomes stop the
sequence. A completed order has no next item and cannot request another signature.

The same order ID, asset addresses, non-extractable keys and original history are
retained throughout. Claims and exact SDK transaction bytes bind `itemIndex` and
asset. Existing item-zero records and durable key formats remain compatible;
later item anchors, send claims, outcomes and replacement records use their own
asset identity. No index-zero key is reassigned to another item.

Storage replays every canonical event and each item's signing history at its
actual historical revision. An order with missing canonical signing rows cannot
authorize a new item's native signature. A later replacement retains its
`originalClaim`, and signed replacement versions 1 and 2 also retain `originalRequest`;
the original revision is not guessed from an item's position. The corresponding
native, wallet, cost, outcome and replacement evidence must all agree. Historical
reads use `readBuyerAttempt(scope, attemptNumber, itemIndex)`; omitting itemIndex
preserves the earlier item-zero API.

All normal mutable APIs still require possession of all original keys. The
separate [custody-loss review](CUSTODY_RECOVERY.md) remains read-only and cannot
advance an order, replace a key or manufacture missing history.

## Fresh chain checks

Before a later item can be signed or sent, the gateway revalidates the verified
prefix using finalized signature statuses, exact transaction messages rebuilt
with the pinned official SDK, and the original receipt slots. Current Core
accounts must retain their expected buyer, collection and metadata. A previous
asset that has changed, or a missing/unverified historical receipt, blocks the
next item. A journal's normalized `verified` label alone is not sufficient.

The current and later asset accounts must remain absent. Required inventory is
the remaining unfulfilled quantity, rather than the original order quantity.
The existing guard, price, balance, blockhash, rent, fee and simulation checks
still apply. Prefix receipts and accounts are checked again at the relevant
freshness boundary. Cached preparation is not a new permission to sign or send.

## Costs and consent

Item-zero cost quotes preserve version 1. Later-item quotes use version 2 and
include completed quantity, remaining quantity and a projection for the
remaining templates. Each quote still binds the current item request and exact
cost ceiling. An earlier item's approval cannot authorize another item, changed
bytes or a replacement. Preparation or recovery does not imply wallet consent.

`readCostSummary(scope)` reports the verified item count, remaining quantity,
known fees from failed attempts, and any retained current template approval.
`verifiedItemPriceLamports` is the nominal subtotal at the approved 0.2 SOL item
price, not a measurement of total wallet debit. Successful transaction fees and
the actual whole-order total remain `null`; a remaining projection is explicitly
an estimate. The interface must not add a projection to a subtotal and describe
it as a guaranteed final debit.

## Bounds and performance

The browser/gateway request-body limit is a fixed 256 KiB. A legitimate
50-item retained history can exceed the earlier 64 KiB limit. Response limits
remain 16 KiB, order storage remains 256 KiB with revision 1024, and signing
history is bounded to 100 attempts and 600 rows. Tests cover large valid bodies
and rejection beyond the body limit.

Storage may reuse validation of one unchanged canonical snapshot and retained
historical batches. Its typed identity preserves property order, missing values
and array holes. A replacement batch also depends on its previous attempt's
records. Changed evidence invalidates the corresponding validation; failed
validation never replaces a successful cache entry. Internal replay objects do
not escape. Native key possession is checked on every normal read, independently
of these caches. Public-address subgroup math may be memoized with a bounded
cache; this stores no secret or signing authority.

Existing gateway cooldowns, daily check/RPC/simulation budgets and sender gates
are unchanged. Revalidating an increasing prefix costs additional RPC requests.
A 50-item order may need to pause and resume after a budget reset; this module
does not promise one uninterrupted session or one wallet approval for 50 NFTs.
The retained current item must be reconciled before any later action.

## Verification boundary

New portable, workerd/SQLite and Chromium fixtures cover later-item preparation,
prefix receipt/account tampering, wrong-item evidence, paid failure/replacement,
unknown-outcome blocking, fresh consent, large bodies, cache invalidation and a
complete 50-item retained browser sequence. Chromium runs in a dedicated matrix
group. Adding a test does not establish its result: the PR and continuation
checkpoint record the completed runs and exact coverage.

All fixture wallets and RPC replies are disposable or intercepted. These tests
do not establish real wallet, physical phone, live Devnet, public gateway or
Mainnet readiness. The private purchase interface and real private setup are
separate stages. No public site content, original artwork, secrets or existing
real operation data is changed by this stage.
