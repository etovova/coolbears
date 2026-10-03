# Read-only outcome review after custody loss

An intact order journal and signing history can outlive a browser asset key.
`readRecoverySnapshot(scope)` checks the canonical order, events, claims, saved
bytes and terminal proofs before separately reporting custody availability. A
missing key for any item therefore does not conceal retained outcome evidence.
The normal storage, signing, sending and replacement APIs still require all
original custody proofs. This path neither restores lost non-extractable keys
nor creates replacement keys, wallet claims or purchase attempts.

## Controller

```js
const recovery = createBuyerCustodyRecovery({ storage, scope, transport });
const snapshot = await recovery.snapshot();
const outcome = await recovery.check({ authorizeCheck: true });
```

The controller is exported by `custody-recovery-client.mjs` and accepts the
existing buyer submission transport. `snapshot()` performs no gateway request.
It reports the selected evidence source, its current status, `canCheck`, and the
storage snapshot including per-item custody availability. An absent scope is
`missing-order`; a fresh order without an attempted transaction is
`no-outcome-evidence`. Neither condition permits a gateway check.

An explicit `check` selects one existing read operation:

| Retained evidence | Existing transport operation |
| --- | --- |
| Valid saved buyer-signed response | `recover(input)` |
| Native partial and genuine wallet claim, buyer response missing | `recoverResponse(input)` |
| Genuine native claim, with or without saved native partial | `recoverPrewallet(input)` |

The same validators used by these existing flows validate the exact request and
response bindings, signatures, finalized outcome proof, and failure fee evidence.
A saved terminal `verified`, `failed` or `expired` state returns
`already-recorded` and its outcome without a gateway request. The signed-response
source takes precedence over its duplicate terminal response-recovery summary.

Fresh checks return `verified`, `failed` or `unknown`, the source, custody status
and validated `report`. A failed outcome includes the proved `feeLamports`.
There is no expiry review or replacement operation on this controller. An
`unknown` result does not authorize another attempt.

## Read-only guarantees and races

The controller has only `snapshot` and `check`. It calls no local write, wallet,
signing, send, key-generation, cleanup or replacement API. It requires no wallet
connection or persistent-storage permission. Storage may perform its existing
domain-separated custody challenge signatures when inspecting surviving keys;
these are not transaction signatures.

The existing gateway recovery routes read RPC and can retain discovered outcome
evidence in their existing server journal. They do not broadcast transactions.
The new controller does not persist a fresh report into the browser order: its
read-only result must not be presented as a locally reconciled order. The local
canonical history, key rows and existing signing claims remain unchanged.

After a gateway response, the controller rereads and compares the entire
canonical snapshot, including order, signing and recovery states. A changed or
disappeared history rejects the result with `STALE_RECOVERY_SNAPSHOT`; corruption
on the reread fails canonical validation. Custody availability alone may change
without invalidating the retained evidence. Returned custody describes the final
read. Request inputs and scope are copied to prevent dependency or caller
mutation from changing those bindings. Concurrent operations return `BUSY`, and
failures release the controller for a later explicit check.

Every public result retains `readOnly: true`, `readyToSign: false`,
`readyToSubmit: false`, `retryAuthorized: false`, `salesOpen: false` and
`transactionsSent: 0`. Unsafe gateway capability flags are rejected, including
flags in a nested discovered result. Missing native claims, orphaned storage,
broken event history or corrupt saved bytes remain blocking errors. No evidence
is reconstructed from an absent claim, and no browser row is erased.

## Coverage limits

Node tests use disposable signatures, the existing transaction/proof validators
and intercepted RPC responses. Browser integration exercises actual IndexedDB
and Web Crypto with disposable test data. These checks do not establish behavior
on a real wallet, physical phone, live Devnet endpoint, erased browser profile or
another device. This is retained-evidence outcome review, not device migration
or recovery of erased custody or journals.
