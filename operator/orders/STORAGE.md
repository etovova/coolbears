# Browser custody and order storage

This is a **Devnet custody foundation**, not a purchase executor or a public
website feature. Sales remain closed at 0.2 SOL. [Asset partial signing](SIGNING.md)
is now available for the first item of a fresh order. There is no buyer wallet
connection, RPC request, submission, gateway, UI or Mainnet path. The existing
read-only preflight is not yet connected to this store.

## What is durable

`browser-storage.mjs` uses IndexedDB `coolbears-buyer-custody-v1`, schema version 2 (same database name). The additive upgrade only creates the
new `signing` store; existing orders, history and keys are retained.
A scope is the ordered tuple `id, cluster, buyer, machine, collection, guard`.
Creation generates one native WebCrypto Ed25519 pair per item (1–50), with a
non-extractable private key. The order, all CryptoKey records and initial history
are added in **one transaction**. All writes request `durability: 'strict'`,
require that capability, and resolve only after transaction completion followed
by read-back and key-possession checks. Strict durability is a browser hint,
not a guarantee against device/profile loss.

The portable `journal-model.mjs` keeps the existing offline model's policy,
history and transition rules. The Node `journal.mjs` preserves its old exports
and shared policy object. Browser code uses the approved JSON policy directly;
it does not bundle Node file access or the operator preparation CLI.

Every read validates the scope, order, complete replay of stored events, key
count and identities. It signs an internally generated, domain-separated random
challenge and verifies it using each stored public key. No custody challenge or challenge signature
is exposed. No API returns private keys or exports a signer. Asset partial signing accepts
only bytes that match a fresh order and an independent SDK reconstruction. Missing/mismatched keys or history block continuation without
a replacement key, rollback, deletion or automatic migration.

## API

```js
import { createBuyerStorage } from './browser-storage.mjs';
const storage = createBuyerStorage();
const scope = { id, cluster: 'devnet', buyer, machine, collection, guard };
const order = await storage.create({ ...scope, quantity: 2, available: 100 });
const restored = await storage.read(scope); // null only if the whole scope is absent
const paused = await storage.append(scope, { type: 'pause', revision: restored.revision });
storage.close(); // connection only, never data deletion
```

Each operation holds a Web Lock for its scope with `ifAvailable: true`:
a competing tab receives `ORDER_BUSY` immediately. There is no forced lock
steal, lease expiry or queue that might later issue an unintended operation.
Within an IndexedDB read/write transaction, append checks the previous snapshot,
adds one event under the next revision, and updates the order together. Repeated
creation and stale callbacks cannot overwrite committed state. The Web Lock is
released between API calls; this is **not** a lock around a future wallet/network
operation. Such an executor must first persist its intent and verified bytes.

`append` is a storage primitive for a trusted future adapter. It enforces the
model, but does **not authenticate** a wallet signature or a normalized
`reconcile` proof. Never expose it as an untrusted HTTP/UI evidence endpoint.
A saved `signed`/`verified` model state alone is not authority to send or claim
on-chain success. A resumed active attempt still requires reconciliation.

Each order is capped at 256 KiB and revision 1024; event inputs at 16 KiB.
Exceeding a cap stops writes and retains existing history. Reads/open/write
errors fail closed; opening has a 5-second deadline and transactions 10 seconds.
A timed-out/failed call must be read again before an explicit decision: an error
after commit can mean the data was saved. There is no automatic replay/re-sign.
The existing `coolbears:offline-order:v1:*` localStorage namespace is untouched.
There is no list-all, cleanup, legacy localStorage migration, export or delete API.
The additive v1→v2 IndexedDB schema upgrade is described in SIGNING.md.

## Limits

Keys belong to one browser profile and origin. Non-extractable means WebCrypto
export is disallowed; it is **not** protection against compromised same-origin
JavaScript invoking the key, nor an encrypted backup or hardware key guarantee.
Clearing data, browser eviction, private browsing, moving origin/device or losing
the profile can lose custody. This stage does not claim permanent persistence,
request persistent-storage permission or implement backup/recovery of erased
keys. Unsupported IndexedDB, strict durability, Web Locks, CryptoKey cloning or
Ed25519 blocks the operation; no plaintext or localStorage fallback exists.
Do not use this stage for a live purchase until the persistence policy, wallet response persistence, fresh network
checks and sender/recovery are complete.

## Verification

`node operator/tests/order-storage.browser.mjs` uses actual Chromium, real
IndexedDB and native WebCrypto on loopback with a disposable profile. It tests
50 keys through reload and full browser restart, key export rejection, unknown
history after a lost completion response, two-tab creation/CAS/lock release,
scoped identities, atomic failure/abort, missing/corrupt keys/history and missing
capabilities. External requests are rejected. The report is written to
`operator/build/buyer-storage-chromium/report.json`. Cleanup only removes the
profile created by that test invocation. No real wallet, phone or RPC is tested.

Local model/regression checks and CI results are recorded in the continuation
checkpoint and PR. Adding the Chromium script to CI is not itself a passing
browser result; use the completed report for the actual outcome.

Primary design references (checked 2026-09-23):
- [W3C WebCrypto Level 2](https://www.w3.org/TR/webcrypto-2/): Ed25519 and CryptoKey serialization.
- [W3C IndexedDB 3](https://www.w3.org/TR/IndexedDB/): atomic transactions, overlapping scopes and durability hints.
- [W3C Web Locks](https://www.w3.org/TR/web-locks/): exclusive locks and `ifAvailable`.
