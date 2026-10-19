**Next addition:** [Reviewed response-expiry replacement](RESPONSE_EXPIRY_REPLACEMENT.md)
adds a separate explicitly authorized second attempt with the genuine retained
wallet claim and fresh cost consent. The expiry review itself still grants no
replacement. The stage-specific limits below describe PR56.

# Expiry review after a lost wallet response

A consumed wallet invocation can leave the order unknown without saved buyer
bytes. Positive finalized discovery remains available through
[RESPONSE_RECOVERY.md](RESPONSE_RECOVERY.md). A separate explicit absence review
can retire the attempt only after its original blockhash has expired and a
bounded finalized history review establishes absence. An empty lookup alone
does not establish that the transaction was never processed.

`responseRecovery.reviewExpiry({authorizeExpiryReview:true})` reads the real
native claim, saved partial, wallet claim and historical cost consent. The
same-origin transport calls `/api/buyer/review-response-expiry`. It does not
invoke a signer, submit bytes, refresh a blockhash or authorize replacement.
The original prewallet review continues to exclude recorded wallet invocations.

The review uses the conservative absence checks in
[PREWALLET_EXPIRY.md](PREWALLET_EXPIRY.md): the authentic preparation or
second-attempt replacement anchor, finalized hash invalidity and block height,
archive availability, absent asset and asset history, and at most two pages of
ten payer-history rows reaching a real older-than-anchor boundary. Every row
has retrievable canonical signed transaction bytes, matching metadata and
resolved accounts. Any use of the asset address prevents retirement, even in
a failed or different transaction. Missing, empty, incomplete, pruned or
ambiguous history stays unknown. Work remains bounded by the existing RPC
quotas, 25-second review deadline and 34-call ceiling.

The separate `buyer-response-expiry:v1:` record binds the exact native claim,
request and wallet claim, including any recorded cost consent. The terminal
proof keeps its unknown signature null. There is no invented wallet response,
signature, paid fee or send claim. Durable conflict and anchor checks, atomic
commit and readback precede success. Cached evidence survives a lost HTTP reply,
SQLite restart, credential rotation and paused order revisions without new RPC.

The browser atomically saves the reconcile event, order and terminal row while
retaining all original claims, partial bytes, consent, keys and events. A write
abort cannot leave a partially closed attempt. A lost local acknowledgment is
resolved by reading the terminal state. Old signing, sending, discovery and
replacement actions remain blocked. No second or third attempt is authorized
by this addition.

If genuine late signed bytes were saved before local retirement, the stale
missing-response result cannot overwrite them. The existing explicit signed
expiry review can bind the retained server evidence to the actual verified
signature and close the local signed state without RPC. The original server
record remains unchanged. A callback after local retirement cannot reopen the
attempt. Second-attempt reviews retain the genuine original replacement and
the first outcome and any paid fee.

RPC, same-origin application and durable storage remain trusted. The normalized
absence record is not an independent chain certificate. A busy or unavailable
payer history can remain unknown. Custody loss, absent canonical claims, a new
replacement after this retirement, later order items, full-order cost consent,
purchase UI and real private setup remain separate work.

Automated coverage uses disposable keys, intercepted RPC, actual workerd/SQLite
and Chromium. Exact completed CI results belong in the draft PR and current
project checkpoint. Real wallets, physical phones, Trust Wallet and live Devnet
are not established by these tests. Sales remain closed at 0.2 SOL; generated
submission remains disabled. No merge or deployment is performed.

Primary references checked for this addition:
- https://solana.com/docs/rpc/http/getsignaturesforaddress
- https://solana.com/docs/rpc/http/gettransaction
- https://solana.com/developers/cookbook/transactions/confirmation
