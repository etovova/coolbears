# Exact buyer message and persistent asset partial signature

**PR41 update:** closed Devnet sign-only wallet handoff, prepared-request checks and atomic buyer-response evidence are implemented. See `WALLET.md`. The new internal prepared check can permit signing only; public purchase, sending and sales remain disabled. Earlier milestone notes below describe their original scope.

This stage signs **only the first asset of a fresh Devnet order** (quantity
1–50), using its existing non-extractable CryptoKey. The buyer signature remains
empty. It does not open a wallet, read RPC, submit, open sales or enable Mainnet.
A 50-item order still represents separate independent transactions; this stage
neither signs all 50 nor handles an existing/partial/retry order.

## Trust boundaries

`transaction-model.mjs` makes the existing pinned official SDK planner portable.
The Node `transactions.mjs` keeps its old API and shared order policy. The
structural `buildOrderItemTemplate` reconstructs one exact unsigned message;
it never authorizes a journal transition, skips unresolved history for execution,
or makes the usual `buildOrderTransactions` retry rules less strict.

`signing.mjs` checks a fresh, unpaused revision-zero order and input revision,
Devnet, first item, ordinary prime-order signer keys, canonical base64 and exact
SDK transaction bytes. This binds buyer/payer/minter/NFT owner, asset, collection,
machine, guard, treasury, account roles, blockhash, compute budget, instructions,
no lookup tables and the pinned v0 encoding/1232-byte limit. A self-consistent
hash supplied by a caller is not sufficient; the message is independently rebuilt.

The price amount lives in on-chain Candy Guard state, not in the mint instruction.
Structural equality **does not prove current network, guard price, inventory,
balance, blockhash lifetime, simulation, or full budget**. A supplied
`lastValidBlockHeight` is bound as metadata, not independently authenticated.
The read-only PR38 preflight remains a separate component, not an authorization
provided by an arbitrary JSON result. A future wallet handoff must obtain trusted
fresh checks and enforce the browser persistence policy before asking the buyer.

## Durable protocol

`createBuyerStorage()` now exposes:

```js
const result = await storage.prepareAssetSigning(scope, {
  orderRevision: 0, itemIndex: 0,
  blockhash, lastValidBlockHeight,
  transactionBase64 // exact fully unsigned SDK transaction
});
const restored = await storage.readAssetSigning(scope);
```

1. Hold the per-order exclusive Web Lock. Validate the stored order and all keys,
   then compare the candidate with the exact SDK reconstruction.
2. Atomically append `prepare`, save `wallet-pending` revision 1, and add the
   asset-signing claim. Wait for strict-durability transaction completion,
   re-read the committed state and verify the claim and key possession.
3. Sign the exact message with the asset CryptoKey once. Strict Ed25519 wire
   verification must accept the asset signature while the buyer slot stays zero.
4. Append the ready record without overwriting the claim. Wait for commit,
   re-read and validate everything before returning the partial transaction.

The claim and ready bytes are in the new `signing` object store. There is no
transaction signing callback exposed to callers and no private-key export.
The internal random custody challenges remain separate from transaction signing.

A missing completion response after ready commit is recovered by reading the
identical saved bytes. `prepareAssetSigning` refuses a second call for that
revision. If signing fails, the tab closes, or ready persistence fails after the
claim, the order stays unresolved; `readAssetSigning` returns
`asset-signing-unknown` with `request: null`. It never re-signs, resets the attempt,
changes the asset, replaces a blockhash or discards history. Recovery of this
unresolved claim is a future trusted, explicit path; there is no retry shortcut.
A failure before the atomic claim commits leaves the initial order untouched
and must not reach the native transaction signer.

`readAssetSigning` returns `asset-partial-saved` plus the claim and partial request
when both records validate. These can be historical evidence, not a current
wallet/sending permission. Every result has `readyToSign=false`,
`readyToSubmit=false`, `salesOpen=false` and false network/guard/hash verification
flags. Generic `append` retains its model-only trust boundary: never treat an
untrusted normalized chain proof as verified evidence.

## Buyer response verification

`verifyBuyerSigningResponse(order, claim, request, {transactionBase64})` is a
**pure verifier**, not a wallet call or a saver. It independently rechecks intent,
the durable attempt binding, original asset signature, unchanged message and a
strict valid buyer signature. A late response may be examined for `unknown`,
but the function does not mutate that state or enable sending. A conflicting
known signature or an already advanced/retried attempt is refused. Raw signed
bytes and signature still need a future atomic response store before any sender.

The existing strict deployment wire/signature utility is reused internally only
after buyer-specific intent reconstruction. No deployment request or deployment
signing authorization is issued by this path.

## Additive schema upgrade and limits

IndexedDB retains its name `coolbears-buyer-custody-v1`; its **schema version is
now 2**. Upgrading creates only the missing `signing` store and preserves orders,
events and CryptoKeys. A blocked upgrade fails closed. Existing code closes its
connection on `versionchange`; older v1 code cannot silently write into v2.
There is no conversion/cleanup of legacy localStorage and no automatic creation
of a replacement signer for an old order. [Storage limits](STORAGE.md), profile
loss/eviction and same-origin script limitations still apply.

## Coverage and sources

- Node tests: real SDK bytes; order/attempt/lifetime metadata binding; changed
  accounts/roles/instructions/lookup tables/hash; noncanonical encodings;
  small-order keys; bad partial/buyer signatures; late unknown responses.
- Chromium: additive/blocked v1→v2 upgrade, 50-item first signature, committed
  intent observed before native signing, full restart returning identical bytes,
  altered message, atomic claim failure, native signer failure, failure after
  native signing, competing tab/closed tab and corrupted saved bytes.
- Fixtures use a disposable loopback browser profile and test keys. A synthetic
  buyer response is signed offline for verification; no real wallet or phone is
  tested, and no transaction is sent. The original 7 storage and 7 owner-console
  browser cases still run. Only each invocation's test profile is removed.

Primary references checked 2026-09-23:
[Metaplex Core minting](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/mint),
[Solana transaction structure](https://solana.com/docs/core/transactions/transaction-structure),
[W3C IndexedDB](https://www.w3.org/TR/IndexedDB/).
