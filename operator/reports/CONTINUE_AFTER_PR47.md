# Continue after PR47 — finalized buyer failure recovery

2026-09-24. PR48 commit-time checkpoint. Full exact-head CI/Chromium results
must be read from the PR and latest `CoolBears_Collection(1).md` entry; this
checkpoint does not claim that pending CI passed.

Base PR47 `815a40ff033c2d0b085e241bc9b1615e5ef16d32`, tree
`21e1c8261a048f44af738051aa891719e1a0cd2c`, CI35940734822 success:
415 Node passed + 1 existing skip, 67 Chromium, 36 workerd scenarios. PR47 is
complete; do not wait/restart that completed run.

Branch `buyer-failure-recovery-20260924`, intended stacked draft PR48 over
`buyer-replacement-20260924`. Exact finalized failed receipt + absent asset +
consistent paid-fee metadata now produce a durably retained failure. Server
and IndexedDB commit/read-back before success, preserve all old bytes/claims
and restore after reply loss/restart without retrying signatures or sending.
Attempt two retains first expiry and replacement evidence. No failed-attempt
replacement, third attempt or missing-response recovery is enabled here.

Local validation: 140 Node tests passed (order suites + deployment receipt),
0 failures, 20951.052974 ms. Includes 8 new failure cases. Actual workerd/SQLite:
5 new scenarios passed, 81 intercepted RPC calls, 1 fixture submission,
0 network transactions. Browser bundle compiles; syntax/whitespace passed.
No local Chromium; 6 new linked browser scenarios await full CI.
See `operator/orders/FAILURE_RECOVERY.md` for validation and trust boundaries.

After exact-head CI finishes: inspect final job logs, artifact head and overall
workflow result; fix any regression, then save final totals in PR/continuation
without a result-only commit. Continue with reviewed failure replacement and
missing-response cases, then later items/full-order consent/custody recovery
before UI/private/live gates. Never infer no charge from a failed execution.

Keep sales closed at 0.2 SOL; generated send disabled. No merge/deploy/real
wallet signature/network transaction. Preserve lab2/2, real journals/custody/
bundles/SQLite/locks, site/DNS/protections, RPC/CORS/quota ledger/Helius plan,
all original PNGs/layers/GIF/logo/banner and private metadata. Private bundle,
owner password and separate RPC remain unconfigured; password only owner safe
local TTY, never chat/generated.
