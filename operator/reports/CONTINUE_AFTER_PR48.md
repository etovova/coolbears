# Continue after PR48 — paid-failure replacement

2026-09-24. Base PR48 `05c955e31390d211460a0d79737db0f6036bdcf3` completed
CI 35947962697 successfully: 423 Node passed + 1 skip, Chromium 73, workerd 41.
Do not rerun or wait for that completed stage.

Branch `buyer-failed-replacement-20260924` adds one reviewed second attempt
after the retained first finalized failure. See `orders/FAILED_REPLACEMENT.md`.
The exact already-paid fee must be acknowledged for both preparation and native
signing. The full fee/proof/bytes/claims remain; fresh cost consent binds the
second wallet/send. SQLite version-2 replacement is retained under the existing
single stable key; expiry version-1 records and browser schema 2 stay compatible.
New finalized/confirmed slot floors are distinct. Fresh bytes use a different
hash and a later last-valid height with at least 80 blocks left. Restart or lost
response restores the same record. Neither second failure nor expiry allows a
third attempt. Missing source or conflicting terminal records fail closed.

Validation available before commit:
- 147 order/deployment-receipt Node tests passed, 0 failed/skipped,
  26284.138517 ms. Includes seven new failed-replacement scenarios.
- Actual workerd/SQLite: five new scenarios passed, 97 intercepted RPC,
  two fixture submissions, zero network transactions.
- Browser bundle compiles; new browser runner syntax and diff whitespace pass.
- Six new Chromium scenarios are implemented. No local Chromium is available.
  Full exact-head CI and browser results are still pending at this commit.

Wait for the entire new workflow, inspect finished logs of all primary jobs,
artifact head and overall conclusion. If it fails, fix this branch and await
the complete new-head run. Final results belong in the PR body and authoritative
`CoolBears_Collection(1).md`; do not make a result-only commit or restart CI.

Next: missing native/wallet responses and partial/unsigned attempts, later items
and full-order cost consent, custody recovery, reviewed purchase UI and real
private setup/live read/simulation gates. Preserve every consumed claim; do not
extend attempt numbers or release unknown attempts without proved provenance.

Sales closed, price 0.2 SOL; generated sender disabled. No merge/deploy, live
wallet requests/signatures or network transactions. Do not repeat lab 2/2 or
clear real journals, browser custody, bundles, SQLite or locks. Preserve site,
DNS/protections, RPC secrets/CORS/ledger/Helius and original 10000 PNG, 454 layers,
GIF/logo/banner/private metadata. Real private bundle/password/separate RPC
remain unconfigured; the owner alone enters the password in a safe local TTY.
