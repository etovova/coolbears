# Retained native result recovery — closed Devnet candidate

A native asset signature may have returned successfully while the subsequent
IndexedDB ready write or its readback failed. The durable claim correctly blocks
a second signature, but previously the returned result was discarded. The storage
instance now privately retains that exact validated result until durable bytes
have been read back successfully.

`storage.recoverAssetSigning(scope)` takes only the order scope. It accepts no
replacement signature, bytes, key, blockhash or consent supplied by its caller.
Under the existing exclusive per-order Web Lock it validates the complete current
order, replayed events, CryptoKey possession and signing/replacement history.
If the ready row already exists, recovery compares the exact retained result and
returns the saved state without a write. If the original result is retained and
only its matching claim exists, one strict IndexedDB transaction adds precisely
the ready row. The transaction compares the current order and all signing rows
before writing; a validated post-commit readback precedes returning the result.

The current paused/resumed revision, orders, events, native claim, keys, earlier
attempts and replacement/paid-fee provenance remain untouched. No wallet claim
or sendable buyer response is created. The returned flags still explicitly deny
signing/submission/sales authority. A later wallet step requires its existing
fresh checker, consent and one-use wallet protocol. Recovery itself has no RPC,
wallet or transaction-signing operation. Existing internal domain-separated
custody challenge signatures still verify possession of the saved CryptoKeys.

A failed write or readback retains the same in-memory result for another explicit
recovery call. Concurrent native operations reserve capacity before creating an
intent; at most 50 pending/retained results per instance are allowed, with no
eviction of uncertain results to make room. Successful durable readback releases
capacity; failures before a result exists also release capacity, never the claim.
The store's exclusive lock, strict input validation and history rules still apply.

## What cannot be recovered

This is deliberately volatile, instance-local retention, not a new durable
journal or device backup. A native exception or lost native promise response
provides no result to retain. A different instance/tab cannot acquire it, and
closing/reloading the originating instance loses any uncommitted result. In these
cases recovery returns the existing `asset-signing-unknown` with `request:null`.
No native re-sign, timeout release, replacement hash, new asset or new attempt is
permitted. Successfully committed partials remain readable after full restart.
Unsigned orders remain unchanged and return null; recovery does not prepare them.

The same code supports the already authorized first item, attempts one and two.
A second attempt still needs the original reviewed replacement and paid-fee
acknowledgment where applicable. Restoring its retained native result creates no
third attempt or fresh wallet/cost consent. A genuinely missing native result,
unsigned/partial retirement or retry policy, later items/full-order cost consent,
custody recovery and the reviewed purchase UI remain separate work.

## Validation

Eight native Chromium scenarios are registered in CI: unsigned/absent orders;
repeated ready-write aborts and paused recovery with a second tab; lost committed
readback/acknowledgment; native rejection; corrupted claim; competing active sign;
closed instance; full restart with both committed and uncommitted results. The
existing paid-failure replacement browser scenario additionally exercises second
native result recovery while retaining the prior fee/proof and all old rows, with
unchanged wallet/RPC/native-sign counters during recovery.

These use disposable browser profiles and keys only. Local signer tests and
browser compilation pass; full exact-head CI/browser results must be checked
before claiming success. No real wallet, phone or live RPC is tested here.

Sources checked for this scope, not a claim of complete ecosystem review:
- https://www.w3.org/TR/IndexedDB/ (strict durability, commit and abort)
- https://www.w3.org/TR/webcrypto-2/ (promise-based signing and CryptoKeys)

Sales closed, 0.2 SOL. Generated sender disabled. No merge, deploy, network
transaction, real signature or changes to real journals/custody/bundles/locks.
