# Continue after PR56: reviewed response-expiry replacement

27 September 2026. Base PR56 is complete at
`f94058d09aed72f2016b6724e04009a04ac841e5`; do not repeat its CI or Lab2/2.
The current candidate is `buyer-response-expiry-replacement-20260927`.
The draft PR and the current `CoolBears_Collection(1).md` checkpoint will record
the actual new commit and completed CI. This document is a commit-time handoff,
not a claim that those later checks have completed.

## Implemented

- A separate explicit `responseRecovery.prepareReplacement` reads the real
  first-attempt null-signature response expiry and calls
  `/api/buyer/replace-response-expiry` with its canonical native claim, partial
  request and wallet claim, retaining any genuine original cost approval.
- Replacement version 5 binds that exact invocation and durable expiry record.
  It does not reinterpret the source as unsigned version 4, invent a response,
  signature or paid fee, or permit a third attempt.
- The server checks retained original anchor, quote and conflicts on creation,
  cache restore and second-attempt operations. Fresh finalized absence, context
  and blockhash lifetime checks precede the atomic replacement commit/readback.
- Browser rows and full history are retained and verified. Native signing is
  separately explicit, and the wallet requires fresh cost consent for attempt
  two. Old callbacks and old operations cannot reopen attempt one. After v5 is
  prepared, old review routes fail closed; retained history remains readable.
- Lost preparation replies, restarts and changed credentials restore the same
  replacement without new RPC. Paused sources cannot prepare it; resume can
  rebind only the current response revision, never generate fresh bytes.

## Validation at commit time

- 47 unique targeted Node tests passed: 9 new backend/model, 3 new client and
  35 existing tests across response expiry and replacement variants.
- Actual workerd/SQLite: all 6 new groups passed, 81 intercepted RPC requests,
  zero fixture submissions and no runtime errors.
- Browser fixture bundle and syntax checks passed. Local Playwright is not
  installed; the 10-group Chromium suite is registered in CI and has not been
  executed locally. No local browser download was attempted.
- Independent source and test review found no blocking implementation issue.
  Full CI is pending on the eventual commit; do not report its result yet.
All automated checks use disposable keys and intercepted RPC. Real wallets,
physical phones, Trust Wallet and live Devnet remain unverified for this buyer
flow. The old laboratory result does not verify this candidate.

## Remaining work and constraints

Next: missing canonical claims and custody policy. Then later items/full-order
consent, reviewed purchase UI, real private setup/read/simulation gates and real
wallet/phone checks. Do not treat passing fixture tests as production readiness.

Sales closed at 0.2 SOL; generated sender disabled. No merge, deploy, opening
sales, real wallet signing or network submission is authorized here. GitHub
commits, draft PR and CI are authorized. Do not clear journals, custody, bundles,
SQLite or locks. Preserve RPC secrets, CORS, ledger, Helius, site/DNS, originals
and private metadata. RPC/gateway/storage remain trusted; normalized evidence
is not an independent chain certificate. See
`../orders/RESPONSE_EXPIRY_REPLACEMENT.md` for the new route and provenance.
