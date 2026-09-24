# Reviewed retirement without a saved buyer signature

An existing canonical native claim can now be retired when its transaction has
expired and a bounded trusted-RPC review establishes absence. This covers a lost
native result or a saved partial with no wallet claim. It does not cover a lost
claim/message, custody loss, or an already recorded wallet invocation.

`prewalletRecovery.reviewExpiry({authorizeExpiryReview:true})` reads the actual
claim and optional partial, calls `/api/buyer/review-prewallet-expiry`, and saves
only a validated terminal result. Missing explicit review fails before HTTP.
The adapter neither signs nor sends, obtains no new blockhash, and grants no
replacement. A separate replacement implementation is still required.

The gateway requires the existing durable preparation or genuine second-attempt
replacement anchor. It verifies the Devnet genesis, finalized anchor block/hash,
finalized invalidity of that hash, and a finalized block height beyond the saved
last-valid height. It checks retained archive coverage and finalized asset
account/address-history absence before and after inspecting payer history.

The payer occurs in every candidate message. Review walks at most two pages of
ten finalized rows, newest first, with no duplicates and an actual older-than-
anchor boundary. Every row, including the boundary, must have a retrievable
canonical transaction, matching first signature, slot and error metadata. All
transaction signatures are verified. Legacy and v0 transactions are accepted;
loaded address counts must match their lookup indexes. The payer must occur in
the resolved accounts. Any use of the asset address, including another message
or a failed transaction, prevents retirement. This conservative test also covers
the unknown exact signature without generating or guessing it.

Empty or short incomplete pages, cap exhaustion, pruning, unavailable bytes,
unknown formats, inconsistent metadata, live hashes, observed assets and stale
contexts return unknown. A 25-second review deadline, 34-call ceiling, 64 KiB
response limit and existing gateway quotas bound the work. Busy payer histories
may therefore remain unknown. No background polling or automatic retry is added.

The digest covers every inspected signature, slot and transaction hash. The
normalized expired proof keeps `signature:null`. Its `statusSlot` represents the
last account/address-history context, not a signature-status lookup. Completeness
and finalized metadata still depend on the trusted RPC and same-origin gateway;
archive availability and a history boundary are not independent chain certificates.

One durable `buyer-prewallet-expiry:v1:` record binds the exact claim hash and
proof/evidence. Conflicting send, recovery, failure or ordinary expiry records
fail closed. A lost response, SQLite restart, credential rotation, pause or late
partial can restore that record without RPC. Old check/send/recovery routes and
replacement remain blocked. A second retirement requires the genuine existing
replacement and preserves the first outcome and any charged fee.

IndexedDB appends one reconcile event and one `prewallet-expired` row at the
existing terminal key index 6 in a strict transaction. Claim, optional partial,
keys and past events remain intact. No wallet invocation, signed response, cost
approval or dummy revision is invented. Actual event replay and claim/request/
revision bindings reject stale results. After abort, retained server evidence
can repair the write; lost local acknowledgment is resolved by reading. Volatile
native bytes are released only after validated terminal readback, never re-signed.

Validation: nine new Node tests, four actual workerd/SQLite scenarios and six
Chromium scenarios (the latter require completed CI). Fixtures use disposable
keys and intercepted RPC only; real transactions, wallets and phones are untested.
Sales remain closed at 0.2 SOL; generated sender remains disabled.

Primary sources checked for this implementation:
- https://solana.com/docs/rpc/http/getfirstavailableblock
- https://solana.com/docs/rpc/http/getsignaturesforaddress
- https://solana.com/docs/rpc/http/gettransaction
- https://solana.com/docs/rpc/json-structures
- https://solana.com/developers/cookbook/transactions/confirmation
