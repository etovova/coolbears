# Reviewed replacement after unsigned expiry

PR54 retires a canonical native claim only after a bounded finalized absence
review. A separate explicit replacement step now uses that retained retirement
to prepare one second attempt. No buyer signature or paid fee is invented.

`prewalletRecovery.prepareReplacement({authorizeReplacement:true})` reads the
actual first-attempt terminal history. For unsigned expiry it calls the separate
`/api/buyer/replace-prewallet-expiry` route with exactly `order`, `claim` and
the optional saved `request` (otherwise null). No response bytes or fee
acknowledgment belong to this route. The recovered-failure path keeps its
existing separate paid-fee acknowledgment.

The gateway requires the matching durable `buyer-prewallet-expiry:v1:` record,
an expired first attempt with null signature, and no conflicting ordinary
expiry, failure, recovered response, prewallet recovery or send claim. A fresh
preparation also requires the original blockhash anchor. Unknown, paused,
successful, signed and second-attempt sources cannot authorize replacement.

A finalized asset absence check uses a context at least as new as every prior
proof slot. Only then is a fresh confirmed blockhash requested, with a context
at least as new as that check and enough remaining lifetime. The gateway commits
one version-4 replacement after checking the original evidence and conflicting
records again in the same durable transaction. It reads the saved result back
before returning. A lost acknowledgment or reply restores that same replacement
after restart or credential rotation without further RPC. The original expiry
record remains unchanged and the old attempt remains unsendable.

Version 4 carries the actual unsigned expiry record in `prior`. The first SDK
claim is reconstructed and matched by hash when validating the second claim.
There are no fabricated wallet events, signed responses, historical transaction
IDs or fee fields. The browser preserves the original claim, optional partial,
expiry row, keys and event history. Explicit replacement signing commits and
reads back the new claim before a native signature can be made. A new wallet
signature still requires a fresh cost approval. No third attempt is introduced.

This extends the existing trusted RPC/gateway/storage boundary; normalized proof
is not an independent chain certificate. Tests use disposable keys and intercepted
RPC, including actual workerd/SQLite and Chromium scenarios. Real wallets,
physical phones, Trust Wallet compatibility and live Devnet remain unverified.
Sales remain closed at 0.2 SOL and generated submission remains disabled.

Primary RPC references checked:
- https://solana.com/docs/rpc/http/getlatestblockhash
- https://solana.com/docs/rpc/http/getmultipleaccounts
