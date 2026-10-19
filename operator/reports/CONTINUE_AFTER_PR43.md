# Continuation after PR43: buyer budget and original blockhash

2026-09-23. Candidate PR44, base PR43 commit
325d889ae641eddf3a226336ff306d7ccf27a7ce. PR43 CI35917735199 finished successfully:
375 Node passed, 1 existing skip, Chromium48, workerd25. Do not wait on it again.

Implemented fixed unsigned /api/buyer/prepare with original RPC blockhash,
lastValidBlockHeight and source slot committed/read back from SQLite. Repeated
preparation restores the same bytes, no hash refresh. Check/send require that
trusted record; legacy missing anchors cannot authorize signing/submission.
Read-only finalized recovery still works for unanchored attempts.

First-item budget includes RPC message fee/rent plus 1500000-lamport Core charge,
with exact simulated asset/account allocation verification. Full order is an
explicit integer-lamport projection, not a future exact bill or balance guarantee.
See orders/PREPARATION.md for contracts, limits and sources.

Local: 64 distinct Node tests passed (63 together,12907.81052ms;
18 RPC tests including one additional case,671.232725ms); gateway workerd6 (24 intercepted
calls), submission workerd5 (34 calls,2 fixture submissions), zero network
transactions. Browser bundle built, local Chromium unavailable. Full exact-head
CI/Chromium pending at commit time; final results belong in PR and authoritative
CoolBears continuation without changing this commit just for CI results.

Next: explicit user cost approval and quote ceiling, abandoned/expired-attempt
review, subsequent items, custody recovery policy, real private setup and reviewed
UI. Password only owner's safe local TTY. No implicit live action. Keep sales
closed at0.2 SOL, preserve completed lab2/2, site/DNS/protections, originals,
private metadata, real journals/bundles/custody/SQLite/locks, RPC secrets and plan.
