# Hidden Settings buyer candidate

This opt-in candidate uses the current Core Candy Machine Hidden Settings profile. It does not open sales, enable submission, deploy a service, or authenticate production custody. The default config-lines candidate and its v1 orders remain available unchanged.

## Trusted profile

Pass a separately reviewed public storage profile to factories:

```js
const storageOptions = {
  storageMode: 'hidden-settings',
  hiddenCommitmentSha256: verifiedCommitmentSha256,
};
```

`hiddenCommitmentSha256` must be the actual nonzero lowercase SHA-256 commitment for the privately verified final mapping. A disposable test hash is not a production mapping or a readiness result. No final metadata, attributes, art, private CID, or wallet secret belongs in this profile.

`createOrderModel(policy, storageOptions)` creates a v2 order whose immutable scope includes both fields. Default `createOrderModel(policy)` rejects v2 orders. A supplied different hash cannot replace the scope, reuse an old claim, or restore the order through a differently configured gateway. The pure `createProtocolOrderModel` dispatcher validates portable byte/evidence records only; trusted browser/gateway boundaries still require their independently pinned profile.

Browser custody uses `createBuyerStorage({storageOptions})`. Every corresponding scope includes `storageMode` and `hiddenCommitmentSha256`. IndexedDB scopes, console indices, and hidden local journal keys are distinct from the previous v1 scopes. This implementation does not delete or migrate existing journals, keys, or uncertain outcomes.

Buyer console and gateway configs use version 2 and add the same two profile fields to the existing cluster, origin, machine, collection, and guard bindings. Version 1 configs reject these fields. The production console factory keeps submission disabled for both versions.

## Buyer costs and exact metadata checks

The buyer remains the fee payer, Core mint payer, NFT owner, and Candy Guard payer. The listed price remains 0.2 SOL. Each quote separately includes the current network fee, exact asset rent, and Core protocol charge; the buyer must approve the total before the wallet request. Failed transaction fee evidence remains payable by the actual buyer and is retained during recovery. This profile introduces no owner subsidy or extra hidden mint surcharge.

Hidden Settings substitute a plain decimal one-based index into the on-chain name and `/metadata/hidden-indexed/<index>.json` URI. The trusted verifier reads `itemsRedeemed` from the complete closed machine account, verifies its exact commitment/name/URI profile, and quotes the next index. Simulation must return the exact corresponding asset bytes and rent/protocol balance. An index change between the initial read and the final account read blocks signing and requires a fresh check.

Finalized recovery validates the exact signed mint transaction, asset owner and collection, canonical indexed URI, and matching plain decimal on-chain name. Legacy padded paths, leading-zero indexed paths, altered names, nonfinalized receipts, missing assets, and mismatched transaction bytes cannot produce a verified hidden outcome. Stored recovery evidence never authorizes another signature or send by itself.

## Explicit local CLI

The optional profile file contains only the two public fields above. It is read using the same bounded, regular-file, no-symlink rules as an order file. Existing commands still select the original config-lines policy.

```sh
node operator/orders/check.mjs preflight --storage-profile private/storage-profile.json private/order.json
node operator/orders/gateway/prepare.mjs --storage-profile private/storage-profile.json private/order.json https://approved-private-origin.example
```

Gateway preparation creates a new private directory exclusively and refuses to overwrite an existing candidate. These commands do not deploy or send. The read-only preflight requires an explicitly configured trusted RPC endpoint and never returns executable transaction bytes in its CLI summary.

## Verification boundaries

New `order-hidden-profile`, `order-hidden-gateway`, and `order-hidden-recovery` Node suites cover immutable mode/hash admission, unchanged v1 records, mixed-mode persistence, synthetic SDK mint bytes/signatures, quantities 1 and 50, buyer-paid costs, full gateway/checker composition, stale-index denial, preparation restore, explicit CLI selection, finalized success/failure, lost native/wallet result recovery, and the next item after an authentic finalized prefix. Changed prefix metadata blocks the later item's check. Every RPC response and key used by these tests is disposable. They do not establish real-wallet, physical-device, live Devnet, Mainnet, marketplace, or private mapping readiness.
