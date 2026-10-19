# Private buyer candidate

This is a private, closed network-scoped review interface over the existing Core/Core
Candy Machine buyer adapters. It is not part of the public website. The
production factory always disables sending; neither configuration nor URL/UI
options can enable it. Sales remain closed at 0.2 SOL per item.

## Build and serve privately

From the repository root:

```sh
node operator/orders/buyer-console/build.mjs
node operator/orders/buyer-console/build.mjs --config private/buyer-console.json
```

Without configuration, the output is a blocked candidate with no enabled
wallet, storage or network controls. Output defaults to
`operator/build/private-buyer-console/` (ignored by Git); `--out` can select a
different local output directory. `app.js`, `LEGAL.txt`, the bundler's legal
notice, HTML, CSS and recommended `_headers` are packaged locally. Building does
not start a server, create a key, configure a gateway or publish anything.

The private JSON must contain exactly these fields, populated from an already
reviewed deployment: `version: 1`, `cluster: "devnet"`, HTTPS `origin`, and
canonical Solana public addresses `machine`, `collection`, `guard`. Do not put
RPC URLs, API keys, wallet secrets, inventory files, final metadata, or a send
switch in this file. The builder rejects extra fields and unknown clusters. No
real configuration or deployment addresses are supplied by this change.

A separately reviewed Mainnet candidate uses `cluster: "mainnet-beta"` and the
mandatory exact `genesisHash` from the static [network profile](../../MAINNET.md).
Hidden Settings uses version 2 with `storageMode: "hidden-settings"` and its
reviewed public commitment hash. The gateway separately requires the externally
supplied trusted storage commitment; this browser configuration cannot authorize
a gateway or change its upstream. The builder accepts only these two exact
network profiles, freezes the selected configuration and reports its cluster.
Mainnet packaging additionally requires explicit `--mainnet`; the factory API
requires `authorizeMainnet: true`. Missing or crossed grants fail before output
creation, storage access or wallet calls. The builder embeds this trusted literal
separately from the configuration; configuration alone cannot activate Mainnet.
There is no URL, UI, local-storage or environment network selector. No Mainnet
configuration is activated by these source changes.

For a separately authorized private setup, serve these static files at that
exact HTTPS origin behind the existing buyer gateway routes. Preserve the
generated no-store/CSP headers. Opening the HTML as a local file or serving it
from a different origin leaves the production interface blocked. The bundle
contains no service worker, external fonts, analytics or third-party scripts.
Do not place this output in the public website build or expose a private host
without its separate review and authorization. The gateway sender remains
disabled as well.

## Explicit flow

1. Review the browser profile/storage limitation and explicitly request
   persistent storage. Connect one Wallet Standard wallet supporting the selected
   profile (`solana:devnet` or `solana:mainnet`) and
   `solana:signTransaction` and choose its exact account. Send-only wallets are
   excluded, regardless of the public site's compatibility filter.
2. Create 1–50 items or open saved progress. The local scope index retains only
   an order ID and buyer public address, never asset keys or metadata. The
   pointer is saved under a configuration-scoped Web Lock before creation, so
   concurrent tabs cannot drop each other's pointers and a lost creation reply
   remains recoverable. Configuration field order does not change this scope.
   Other saved pointers are never erased. `available = quantity`
   is only a conservative planning limit; it makes no claim about live supply.
   The existing preparation gateway must verify actual availability.
3. Explicitly prepare the next item. Request a fresh estimate, inspect its
   components and maximum total, then separately approve one wallet signature.
   A fresh gate check still occurs in the existing wallet adapter. Unknown
   outcomes stop progression. Each subsequent item requires a new estimate and
   approval; there is no promise of 50 items in one wallet window. If a wallet
   response is retained only in memory after a persistence failure, a separate
   action retries saving those exact bytes without another wallet invocation.
   Reconnecting, switching scopes, ordinary gateway recovery, expiry review and
   attempt advancement are blocked until that pending response is saved. This
   prevents an expiry transition from making the only retained response
   impossible to persist. If custody is lost, read-only outcome review remains
   available. Reloading can still lose volatile bytes and is not a recovery method.
4. Sending is a separate operation and is visibly unavailable in this
   production candidate. Outcome review remains usable without sending.
   Ordinary recovery commits through the existing validated adapters when
   custody is intact. With missing custody it uses read-only outcome review
   and does not present a fresh report as a locally reconciled order.
5. Expiry review is explicit. A replacement first requires a terminal attempt
   and acknowledgment of its actual failed fee, when applicable. Review the
   replacement, then separately approve creating its new asset signature.
   The reviewed report is held only in memory and bound to the exact canonical
   snapshot. Reload, changed history/custody, or wallet changes require review
   again. A fresh wallet cost approval is still required afterward.

Pause/resume retains all progress and invalidates the current quote. The first
unprepared item cannot be paused because its initial preparation requires
revision zero; pause becomes available after preparation. A new order can be
started from a validated absent scope or a completed order, while retaining the
old index. An unresolved attempted order cannot be dismissed into a new order
through that action. Restored scopes never reconnect, sign, send, or retry
automatically.

The nominal price of verified items, known failed-attempt fees, the next transaction
estimate and remaining projections are presented separately. Successful
transaction fees and actual full-order total remain explicitly unknown when
the existing cost-summary adapter does not know them. A projection is not an
amount charged. The interface does not display asset IDs, private reserve
details, rarity or final metadata.

## Validation and limits

```sh
node operator/tests/order-buyer-console.test.mjs
node operator/tests/order-buyer-console.browser.mjs
node operator/tests/order-buyer-console-integration.browser.mjs
```

Node controller tests exercise distinct consents, stale quotes, account change,
scope recovery, missing custody, pause, multi-item handoff, failed-fee
acknowledgment, separately reviewed replacement signing, exact SOL parsing and
the actual production factory's disabled-send behavior, normal connection
events, serialized scope-index writes and retained wallet response recovery. UI port fixtures do not
claim to be chain evidence or real wallet signatures.

Chromium tests operate the real HTML/CSS/view and controller with explicitly
simulated dependency ports, verify blocked/restored states, and produce desktop
and mobile-viewport screenshots in `operator/build/buyer-console-chromium/`.
The default blocked production bundle is also loaded. A separate configured
production-factory smoke exercises actual UI, native IndexedDB/Web Locks, HTTPS
adapters and workerd/SQLite through sign-only and restart recovery with a
disposable synthetic wallet and intercepted RPC responses; both send gates stay
closed. Its report is retained in `operator/build/buyer-console-integration-chromium/`.
Existing lower-level
adapter tests provide transaction, IndexedDB and gateway coverage separately.
This UI has not been verified with real wallets, a physical phone, live Devnet,
an erased profile, or a private deployment. A viewport test is not a phone test.
