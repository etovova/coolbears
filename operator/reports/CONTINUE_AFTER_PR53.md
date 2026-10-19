# Continue after PR53: unsigned prewallet expiry retirement

24 September 2026. Base PR53 is complete on
81a81e1da89102edc2d08c0fdb877f8279ac4eb5, CI36044086355 successful:
450 Node passed / one old skip, 113 Chromium and 60 workerd/SQLite scenarios.
Do not wait for or rerun PR53.

The next branch adds bounded trusted-RPC expiry review for a saved native claim
without a buyer signature. Finalized lifetime, complete inspected payer history
and repeated asset absence checks are required. Unknown history remains unknown.
No signature or wallet history is invented. Server and browser preserve one
terminal record across lost replies and restarts; no replacement is granted.
Implementation and limitations: `operator/orders/PREWALLET_EXPIRY.md`.

Local nine new Node tests, 24 related existing Node tests and four new actual
workerd/SQLite scenarios passed. Browser syntax and bundle are checked locally;
Chromium itself is unavailable locally. Six new browser scenarios are registered
in the full workflow. At this pre-commit checkpoint the full new CI is pending;
the current PR body and CoolBears_Collection(1).md must supply its final result.
No old CI result can establish success for the new head.

Next: separately reviewed replacement after this unsigned retirement, recovery
for missing responses with an actual wallet claim, later items/full-order consent,
custody recovery, reviewed purchase UI, then authorized real private setup and
read/simulation gates. Do not imply this retirement already grants a fresh attempt.

GitHub branch/draft PR/CI saving is authorized. No merge, deployment, sales opening,
real signature or blockchain send. Sales closed, price 0.2 SOL, generated sender
disabled. Preserve actual journals/custody/SQLite/locks, secrets/CORS/ledger/Helius,
site/DNS/protections, 10000 PNG, 454 layers, GIF/logo/banner and private metadata.
Do not repeat Lab2/2. Owner password only in their safe local TTY.
