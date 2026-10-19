# Reviewed replacement after a lost wallet response expired

PR56 preserves a genuine wallet invocation whose response was lost and retires
it only after the bounded finalized absence review. A separate explicit action
can now prepare one replacement of that first attempt. The original native
claim, partial, wallet claim, cost consent and null-signature retirement remain
evidence; no response, signature or historical fee is invented.

`responseRecovery.prepareReplacement({authorizeReplacement:true})` reads the
retained first-attempt response expiry. The dedicated
`/api/buyer/replace-response-expiry` route receives exactly the order, native
claim, partial request and actual wallet claim. The server must retain the same
`buyer-response-expiry:v1:` record. This is distinct from the unsigned version-4
replacement and from a replacement after a signed or paid failed transaction.

Only an unpaused expired first attempt with a null signature and no started
later items can request fresh preparation. The server verifies the original
anchor and absence of conflicting results and send records. A fresh finalized
asset lookup must be at least as new as the prior evidence, followed by a fresh
confirmed blockhash with a sufficiently recent context and remaining lifetime.
Original evidence and conflicts are checked again inside the durable commit.

The version-5 replacement retains the exact response-expiry record and original
request and wallet claim. Its identifier binds that provenance to the new
anchor and unsigned bytes. A cached result is restored after lost replies,
restart or credential rotation without obtaining another blockhash. The
original expiry and consumed claims are never cleared or released.

Browser storage independently validates the new record against retained rows
and history. Preparing a replacement does not sign it. Explicit replacement
signing first commits a new native claim; the wallet stage requires fresh cost
approval for the new request. Original consent cannot authorize new bytes.
The existing separate send and recovery stages retain their gates. There is
no automatic retry, third attempt or reopening of the original wallet callback.

RPC, gateway and browser storage remain trusted. Structural provenance is not
an independent chain certificate. Missing canonical data or custody, later
items, full-order spending approval, purchase UI and real private setup remain
separate work. Sales remain closed at 0.2 SOL; generated submission stays off.

Tests use disposable keys and intercepted RPC, including workerd/SQLite and
Chromium. Exact completed results belong in the draft PR and the current
project checkpoint. These tests do not establish real-wallet, physical-phone,
Trust Wallet or live Devnet compatibility. No merge or deployment is included.

Primary RPC references checked for this addition:
- https://solana.com/docs/rpc/http/getlatestblockhash
- https://solana.com/docs/rpc/http/getmultipleaccounts
