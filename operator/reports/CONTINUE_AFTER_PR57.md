# Read-only custody recovery candidate — 2026-10-03

Base: PR57 `bdd317989c3157dfce775713b42598285e0cf6a2`, whose completed CI
36344481500 is retained evidence and was not rerun for restoration.

The new recovery snapshot validates canonical order/events/signing history
independently of possession of all original CryptoKeys. It reports missing,
invalid or mismatched custody without returning keys, altering rows, repairing
claims or granting mutable permissions. Ordinary APIs still require full custody.

The explicit read-only controller uses the existing signed, missing-response or
prewallet outcome route, validates the response, and rereads unchanged canonical
evidence before returning it. Saved terminal evidence needs no network request.
Fresh outcomes are not saved in the browser. Gateway recovery may preserve its
existing durable evidence, but cannot send. Unknown outcomes remain unknown.

Targeted storage validation: 7 new named Node cases and 11 existing signing cases
passed. Client cases, browser integration and final CI results must be checked
in the PR and current continuation checkpoint; this commit-time report does not
claim a completed CI run. The new Chromium suite contains 11 scenario groups
and runs in the recovery matrix. Syntax and browser bundle checks passed.
Local Chromium download failed with an invalid ZIP; no local browser pass is
claimed. The runtime package version remains the version pinned in CI.

The next development stage is sequential items 1–50 with a verified prefix,
fresh per-item cost consent and a cumulative cost presentation, followed by a
reviewed private purchase interface and concrete private configuration gates.
The user's latest instruction authorizes continuing through these stages
without stopping at each PR.

Sales remain closed, price 0.2 SOL, Core/Core Candy Machine, generated sender
disabled. No merge/deployment, real wallet signature or blockchain send is
authorized by this work. Lab 2/2 is complete and must not be repeated. Preserve
all real journals, custody, private bundles, SQLite and unknown operation data.
Real private setup, live checks and new-flow physical-wallet trials remain
unverified. Erased canonical history or non-extractable keys cannot be invented.
