# Continuation after PR42: first buyer submission and finalized recovery

2026-09-23. Candidate PR43 is based on PR42 b242851896fcc612f6de178fc3eb288f1f90b44e.
PR42 full CI35914467431 passed: 368 Node passed, 1 existing skip, Chromium40,
workerd20. Do not wait on its old runs again.

Implemented separate browser send intent, permanent per-asset SQLite server
claim, exact signed simulation/send and read-only finalized recovery. HTTP
acknowledgment does not prove success; verified receipts must match full signed
bytes and the Core account. Claims survive failure/restart/rotation and never
expire into permission to resend. Default/generated entry disables submission.

Local validation before commit: 7 new Node scenarios, 28 checker/gateway
regressions, 5 new workerd/SQLite scenarios (28 intercepted calls, 2 disposable
fixture submissions, zero network transactions). Browser bundle/syntax pass;
local Chromium unavailable. Full CI and new Chromium integration are pending
at commit time; final results go in PR and authoritative continuation file.

See orders/SUBMISSION.md. Remaining: complete cost disclosure, original blockhash
provenance/lifetime, retry review, later items, real private configuration and
reviewed UI before real purchases. Password only in owner's safe local TTY.
Never silently activate send, deploy, merge or open sales. Price0.2 SOL, closed.
Preserve completed 2/2 lab, real journals/bundles/custody/SQLite/locks, site,
DNS/protections, RPC secrets, Helius plan, originals and private metadata.
