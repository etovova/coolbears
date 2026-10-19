# Continue after PR39: exact asset signing and persisted partial result

2026-09-23. Base PR39 `8cc5d5b6fdeb324fff51a5b21a803136ecece7a4`.
Branch `buyer-asset-signing-20260923`; stacked draft, not merged or deployed.

The portable official SDK planner independently reconstructs the exact message.
New signing verifies canonical bytes, buyer/asset/roles/guard/treasury/instructions
and durable attempt binding; a supplied hash is never sufficient. The browser
store atomically saves prepare + wallet-pending + claim before native asset
signing, then persists/validates the partial result before returning it. It keeps
the buyer slot zero. Read returns saved bytes without re-signing; interrupted
claims remain unresolved. Scope is first item, first attempt, fresh Devnet order
(1–50 items). There is no existing-order/retry signing path.

IndexedDB schema v2 adds only `signing`; existing orders/events/CryptoKeys and
legacy localStorage remain. Unknown/failed result persistence cannot erase a
claim or enable another signature. Pure buyer-response verification checks exact
message, original asset signature and strict buyer signature; it does not call
a wallet or save/send its result.

Local checks: prior order model/journal/planner/preflight **42 passed, 0 failed**,
6736 ms; new signing **11 passed, 0 failed** (final log /tmp/pr40-signing-final.log).
Browser module and fixture builds, syntax and whitespace checked. Actual Chromium
cases and full CI are **pending at commit time**. The PR and persistent checkpoint
will receive final results; do not mistake this commit-time pending note for the
current outcome. CI adds 8 signing cases before 7 storage + 7 owner-console cases.

All browser signing uses disposable native/test keys, a loopback server and an
offline synthetic buyer response. No real wallet, phone or RPC tested; no network
transaction sent. Native custody challenge signatures are separate from the
single asset transaction signature checked by the audit hook.

Next: trusted fresh preflight + buyer wallet handoff, atomic response storage,
separate buyer gateway, sender/finalized recovery and persistence/eviction policy.
Partial signature is not network/price/hash/budget validation or sale permission.
Always readyToSign/readyToSubmit/salesOpen=false. No live site or Worker changes.

Sales closed, 0.2 SOL. Do not repeat lab 2/2 or clear working journal, bundle,
SQLite, locks, browser data or originals. Owner password only in safe local TTY;
real private deployment bundle and separate endpoint remain unconfigured.
