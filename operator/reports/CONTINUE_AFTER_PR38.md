# Continue after PR38: buyer browser custody

2026-09-23. Base PR38 `f9985fa5780ba17ab95ae058ec6b0000ebb5e9f0`.
Branch `buyer-order-storage-20260923`; stacked draft, not merged or deployed.

Added portable order model and isolated Devnet IndexedDB custody (1–50
non-extractable Ed25519 keys), complete event replay, atomic order/keys/history,
Web Locks, revision CAS, commit/read-back and key possession checks. No wallet,
RPC, transaction signatures, sender, UI, migration or cleanup API.

Local checks: existing order journal/planner/preflight **40 passed, 0 failed**,
6490 ms; new portable-model **2 passed, 0 failed**, 362 ms. Browser bundling,
syntax and whitespace checked. Actual Chromium tests are added to the existing
browser CI job; **CI results pending when this checkpoint was committed**.
The PR description and persistent continuation document will record final
results; do not mistake this commit-time pending status for current CI state.

Seven browser scenarios cover reload/full restart with 50 keys, unknown outcome,
two-tab races, identity scope, transaction abort/quota failure, corrupt/missing
keys/history, unsupported capabilities and unchanged legacy storage. Test
challenge signatures are real native crypto on disposable keys; they are not
Solana transactions. No real wallet, phone, RPC or live transaction is tested.

See `operator/orders/STORAGE.md` for exact API and trust limits. Browser keys
are not a backup or protected against profile deletion/eviction/same-origin XSS.
Strict durability is a hint. Append validates model structure, not chain proof
or wallet signatures. Lock scope is one storage operation, not future sending.
Next: exact mint-message/asset partial-signature verification, wallet handoff,
separate buyer gateway and finalized recovery; connect preflight/storage only
once the executor's trust boundaries and persistence policy are enforced.

Sales closed, price 0.2 SOL. Do not repeat lab 2/2 or clear working journal,
bundle, SQLite, locks or browser data. Original assets/site/DNS/Cloudflare
protections and lab RPC/secrets remain unchanged. Owner password only in safe
local TTY; actual private deployment bundle/endpoint are still not configured.

First browser run (35896307143) passed 50-key full restart and unknown recovery,
then observed ORDER_BUSY immediately after closing the lock-holding tab. The
storage correctly refused concurrent work; the test now waits (at most 5 s)
for the browser lock manager's read-only held-state to clear before asserting
read success. No production lock behavior was weakened. Buyer tests now run
before the longer owner-console suite for faster feedback. Final CI pending.
