# Continue after PR40 — buyer wallet handoff

23 September 2026. Base cce0718664f52b2064fc5df663425f51cd11d6d6;
branch buyer-wallet-handoff-20260923. This is the commit-time checkpoint; CI is
pending here intentionally. Final exact-head results go in the PR description
and the existing CoolBears_Collection(1).md continuation file.

Added a closed Devnet prepared-request checker, sign-only Wallet Standard client,
persistent-storage gate, durable single-use invocation claim, atomic verified
buyer-response evidence and idempotent save/recovery. First item only. The
attempt remains unknown even after a valid signature; no sending or sales grant.
The exact existing message/blockhash is reused, never refreshed or re-signed.

Local validation: 27 preflight/signing tests and 30 model/journal/planner tests
passed (0 failures); browser fixture bundled, syntax/whitespace checked. Actual
Chromium is a required CI gate. New browser tests use disposable keys and fake
wallet/check/persistence services; Node tests separately use the real RPC adapter
with intercepted fixtures. No real wallet or live browser-to-gateway test claimed.

See operator/orders/WALLET.md for trust boundaries and recovery semantics.
Next: trusted transport/buyer gateway, complete purchase cost handling and
submission/finalized recovery, then user-facing purchase UI and real device tests.
Public sales remain closed, 0.2 SOL. Do not repeat completed lab 2/2, recreate
existing deployment or clean working journal/browser/bundle/SQLite/locks.
Do not change lab RPC/secrets, Helius plan, website/DNS/protections or originals.
Actual private deployment bundle/password/separate endpoint remain unconfigured.
Owner chooses the password only in a safe local TTY, never in chat.
