# Private buyer interface and offline setup candidate after PR59 — 2026-10-03

The sequential-order draft is [PR59](https://github.com/etovova/coolbears/pull/59),
head `6b8903f53ba6b603391eaaef257373c12785f265`. Its CI run
`37121913200` was still pending when this candidate was prepared. Do not infer
its final result from this file; the PR and continuation checkpoint record the
completed run. The full PR59 tree is included in this candidate.

This stage adds the [private buyer review interface](../orders/buyer-console/README.md)
and [offline private setup inspection](../PRIVATE_READINESS.md). They remain
separate from the public website and do not deploy a gateway or enable sales.

The interface connects the retained-order adapters through explicit persistence,
wallet/account selection, scope creation or restoration, preparation, fresh cost
review and wallet consent. It preserves unknown outcomes, offers retained-response
and outcome recovery, and separates replacement review from native preparation
consent. Costs distinguish nominal prices, known failed fees, current estimates
and remaining projections. Its production factory always disables sending; a
configuration or UI option cannot enable it. Missing configuration leaves the
production bundle blocked. Missing custody permits only canonical read-only
outcome review. No restored scope automatically signs, sends or retries.

The inspector accepts three explicit existing local directories: encrypted
deployment bundle, owner gateway preparation and buyer gateway preparation.
It checks bounded private files, journal/configuration bindings and disabled
sender entries, then rechecks stability. It does not discover private folders,
unlock a vault, generate keys, edit files, install secrets, make RPC calls or
publish anything. Even `offline-bindings-verified` leaves live prerequisites and
permission to sign, send or open sales unverified. No real inputs were supplied
or inspected for this candidate.

Local fixture validation available while preparing this handoff comprises
13 buyer controller/factory Node cases and seven offline-inspector Node cases.
The private UI browser suite contains seven groups over the actual HTML/CSS/view
and controller with explicitly simulated dependency ports. Actual Chromium and
the combined candidate CI remain pending; authored tests are not completed runs.
A separate single-case configured-factory smoke covers actual UI, IndexedDB,
HTTPS adapters, workerd/SQLite and restart recovery with intercepted RPC and a
disposable synthetic wallet. Its execution is also pending CI.
The fifth Chromium matrix group, `console`, retains its report and desktop/mobile
PNG screenshots in `operator/build/buyer-console-chromium/`, plus the configured
smoke report in `operator/build/buyer-console-integration-chromium/`. All preceding Node,
workerd and four Chromium groups remain present.

Continue with independent review, the combined CI and its screenshot/artifact
inspection. Save completed evidence in the PR and continuation checkpoint without
a result-only commit. Actual private configuration, encrypted custody access,
endpoint/secret installation, fresh live RPC and unsigned simulation, and new-flow
real wallet/phone trials remain external prerequisites. The earlier Lab 2/2
result does not establish these stages and must not be repeated.

The user requested continuing to the end without stopping after each PR. The
existing scope still keeps sales closed at 0.2 SOL and uses Core / Core Candy
Machine. No merge, deployment, real wallet signature or blockchain send is
authorized by these fixture results. Preserve all real custody, journal, SQLite,
lock and unknown-operation data, artwork, site protections and service limits.
