# Continuation after PR44: quote approval and cost ceiling

2026-09-23. Candidate PR45, based on PR44
b39e9dd52ad2262fadee47e08070dda1ac7e01b6. PR44 CI35920901377 already succeeded:
387 Node passed +1 existing skip, Chromium49, workerd26. Do not wait again.

Trusted check quotes are now committed/read back in SQLite. The client obtains
an explicit quote, requires quote ID + maximum + authorizeCost, checks a fresh
quote, then atomically persists approval with its one-use wallet claim before
wallet I/O. Server send also records/validates consent and enforces the cap on a
fresh signed quote, including immediately before outbound I/O. Acknowledgments
bind the same quote/cap/checked total. Legacy evidence stays readable/recoverable;
missing consent cannot create a send claim. No automatic re-sign or resend.

Application ceiling only; not an on-chain maximum debit or human-gesture proof.
Exact trust boundaries and API are in orders/COST_APPROVAL.md. The reviewed
user-facing approval UI is still future work, not silently deployed here.

Local55 Node passed,0fail (12509.536294ms), including9 new consent cases.
Workerd submission7 cases/77 intercepted RPC/2 fixture submissions; checker6
cases/24 RPC. Zero network transactions. Browser bundles compile; local Chromium
unavailable. Full CI and Chromium pending at commit; final results go in PR and
authoritative continuation without changing this commit only for CI status.

Next: reviewed abandoned/expired-attempt recovery, later items, custody recovery
policy, purchase UI/disclosure, private setup and live read-only/simulation gates.
No merge/deploy/sales activation; generated sender stays disabled. Price0.2 SOL,
sales closed. Preserve lab2/2 and all real journals/bundles/custody/SQLite/locks,
site/DNS/protections, RPC secrets/plan and original/private art/metadata. Owner
password is entered only by the owner in a safe local TTY, never chat/generated.
