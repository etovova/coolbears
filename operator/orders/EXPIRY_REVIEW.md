# Explicit buyer expiry review

PR46 closes a saved, fully signed first-item attempt only after a trusted RPC
review proves its original lifetime is over and finds no execution. It does not
prepare a replacement, reopen a wallet, release claims or authorize a retry.
Sales remain closed at 0.2 SOL and generated submission remains disabled.

## Reviewed path

Call `sender.reviewExpiry({authorizeExpiryReview:true})` as a separate explicit
action. The fixed HTTPS transport posts to `/api/buyer/review-expiry`; it cannot
choose an upstream endpoint or supply a blockhash anchor. Only the pinned closed
Devnet owner/order profile is admitted. Cost consent is not required for this
read-only recovery, including old signatures whose approval is missing/expired.

The server uses its original PR44 SQLite preparation anchor and the existing
bounded deployment expiry verifier. It verifies Devnet genesis, the original
finalized block matching the saved hash, a finalized invalid-hash result and a
finalized horizon block height strictly above the original lastValidBlockHeight.
It checks historical signature status and the exact signature's transaction
before and after scanning fee-payer history. History must be finalized, ordered,
exclusive and cross below the original hash block. A missing receipt, empty page,
short page without that boundary, pruned history or a still-valid hash never
proves expiry. At most ten pages of 100 rows are scanned, with a 25-second/24-call
verifier bound and a 30-second total RPC deadline.

The buyer adapter additionally requires the finalized Core asset address to be
absent at a context no earlier than the horizon, its finalized address history
to be empty, and a final absent signature status at least as recent as that
account read. Any observed transaction (successful, failed or pending), asset,
asset history, malformed result or inconsistent context leaves the attempt
unknown. A typical complete fixture review takes 14 read calls. No simulation,
getLatestBlockhash, transaction signature or send is part of this path.

## Durable evidence and recovery

Before reporting success, the server commits and reads back a permanent
`buyer-expiry:v1:<stable-asset-identity>` record. It binds the exact request, signed
bytes, signature and immutable order identity; it retains the original anchor
slot, finalized horizon, history-page count/digest and normalized absence proof.
The key excludes nonce, caller order ID and transaction hash, so changing those
cannot reopen this asset. Missing/corrupt/conflicting records fail closed.

The previous preparation, quotations and permanent send claim remain untouched.
A retired attempt cannot call prepare/check/send, including when its signed
bytes had never acquired a send claim. An explicit repeated expiry review restores
the original proof without more RPC, even after restart, credential rotation or
a lost successful commit acknowledgment. Its response is rebound to the current
validated input revision; it never manufactures a new network observation.

Browser schema remains version2. A strict IndexedDB transaction adds the full
`expiry-reviewed` evidence record, its reconcile event and the expired order
state together, preserving keys, original signed bytes, consent, claims and all
prior events. Reads replay and validate both the event and the stored review.
A changed order during HTTP rejects the stale result. A fresh explicit restore
may save the same server evidence against the current revision and retains pause.
Write abort rolls everything back; a lost successful acknowledgment is recognized
on the next read. After restart, repeated review/recover returns already-recorded
without HTTP, wallet invocation, signing or duplicate events. Older strict
readers reject the additive expiry record rather than treating it as a send grant.

The existing verified-success recovery remains separate. Expiry evidence cannot
be submitted to its proof-writing API and a successful mint cannot be retired as
unexecuted. The gateway's shared daily read budget, serialization, spacing,
cooldown and uncertain-request hold still apply to fresh reviews; cached evidence
restores perform no RPC. No real journals or browser databases are migrated or
cleared by this change.

## Limits and next steps

This is trusted-RPC application evidence, not an independent cryptographic proof
that a public chain has no transaction. RPC archive completeness and consistency
remain trust boundaries. Providers unable to supply the verified lower boundary
leave recovery blocked. A formerly confirmed anchor on a discarded fork also
stays blocked. The code deliberately does not infer absence from elapsed time.

This stage handles the first item/first attempt with saved full signed bytes.
Unsigned/partially signed attempts and wallet outcomes without a saved response
remain unresolved. A finalized execution failure needs its separate review;
this expiry path rejects it. The generic offline journal's retry-review state
is not authorization to bypass the browser/gateway's permanent records.

Next: separately reviewed attempt replacement with append-only history, new
original hash and fresh quote/consent; abandoned/failed/response-missing cases;
subsequent items and custody recovery policy; reviewed purchase UI, private
configuration and live read/simulation gates. No automatic retry or new browser
purchase UI was added, and none of these fixtures prove readiness for sales.

## Coverage

Node covers original-anchor/explicit-action requirements, finalized and history
failures, changing observations, missing assets, persistence failure and lost
acknowledgment, replay/corruption, preserved send claims and altered HTTPS proof.
Real workerd/SQLite covers restart and secret rotation, incomplete history and
retirement of signed-but-unsent attempts. Chromium adds complete browser/server
restarts, stale revision and pause, atomic evidence-write rollback, lost browser
and HTTP acknowledgments, tampered replies and retained send claims. Every RPC
and wallet in these tests is an intercepted/disposable fixture; no live wallet,
physical phone, public deployment or network transaction is involved. Exact CI
results are in the PR and the authoritative continuation.

Primary references checked 2026-09-23:
- https://solana.com/docs/rpc/http/getsignaturesforaddress
- https://solana.com/docs/rpc/http/isblockhashvalid
- https://solana.com/docs/rpc/http/getfirstavailableblock
