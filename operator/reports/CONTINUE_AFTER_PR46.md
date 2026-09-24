# Continue after PR46 — reviewed buyer replacement

2026-09-24. This is the PR47 commit-time checkpoint. Exact final head and CI
results must be read from the PR and latest `CoolBears_Collection(1).md` entry.
Do not infer successful CI from this file.

Base PR46: `200c9c2ddea13fcfc9ed109f3163a08260d0e1f0`, tree
`857a9f651c17c8829b6c4c7b4def75a077b97eb5`, CI35935408718 success:
408 Node passed + 1 existing skip, 61 Chromium, 31 workerd scenarios.
Do not repeat or wait for that completed run.

Branch `buyer-replacement-20260924`, intended stacked draft PR47 over
`buyer-expiry-review-20260923`. Implements one reviewed replacement of item zero
after retained PR46 expiry: append-only server/browser history, new original
blockhash, explicit native signing, fresh cost quote/consent, separate permanent
wallet/send claims and finalized recovery. Old bytes cannot be sent again.
See `operator/orders/REPLACEMENT.md` for trust boundaries and storage behavior.

Local checks at commit: 115 order Node tests passed, 0 failed; includes 7 new
replacement tests. Actual workerd/SQLite: 5 replacement cases passed, 122
intercepted RPC calls, 1 fixture submission, 0 network transactions. Browser
runner syntax checked; no local Chromium. Six new Chromium scenarios and full
CI are pending publication at this checkpoint. Wait for the exact head's full
workflow and finished job logs, then update the authoritative continuation.

Next after complete validation: unresolved/failed and missing response cases,
later items and full-order consent, custody recovery policy, reviewed purchase
UI, private configuration and live read/simulation gates. Never turn missing
history into a retry grant. No third attempt is implemented here.

Keep sales closed, price 0.2 SOL, submission disabled by default. Do not merge,
deploy, request real signatures or send network transactions. Preserve lab2/2
without rerunning, real journals/custody/bundles/SQLite/locks, site/DNS/protections,
RPC/CORS/quota ledger/Helius plan, all original PNGs/layers/GIF/logo/banner and
private metadata. Private owner bundle/password and separate RPC remain absent.
The password belongs only in the owner's safe local TTY, never chat/generated.
