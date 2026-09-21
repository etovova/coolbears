# CoolBears Core v2

Fresh implementation dated 21 September 2026. Approved original artwork and site branding are unchanged. Public sales remain closed.

The collection uses Metaplex Core. The approved collection contains 10,000 NFTs and uses a Core Candy Machine with Hidden Settings. One hidden template replaces uploading 10,000 config lines. The on-chain guard charges 500,000,000 lamports and stays closed until an explicit owner action. The royalty plugin stores 700 basis points. An order contains 1–50 separate mint transactions; it is resumable, not atomic. There is no lifetime wallet limit.

`chain/builders.mjs` creates the collection, first asset, machine, mint and reveal instructions. `chain/runtime.mjs` verifies the network, owner, collection, payment destination and settings before requesting wallet signatures. It simulates transactions, uses the wallet's sign-and-send capability, serializes concurrent browser operations, records target addresses before signing and reconciles uncertain results against finalized chain state. Expired operations reuse their original target, after checking finalized absence. The wallet secret is never requested. Locally generated creation-account keys and operation receipts are exportable for recovery.

`manage/` is the owner interface, restricted to Devnet for this release. `mint-client.js` is the browser client used by the main site's guarded mint flow. Mainnet activation requires a reviewed mainnet deployment, an explicit owner instruction and an update to the release configuration and closed-sale build gate. Nothing in this release opens sales automatically.

Reveal uses an ordered 10,000-entry `{index,name,uri}` array and its SHA-256 commitment. The browser checks finalized Solana time and refuses reveal before 1 January 2027. This is an application restriction; a Core update authority can use other software. No claim of an on-chain timelock is made. Final art must first be published from the private CAR and retrievable through IPFS. Each asset's index, collection and final metadata are checked before updating. Running reveal again processes the same target addresses and also permits later-minted assets to be revealed. Mainnet release operations and actual mobile-wallet signatures require the owner.

## Reproduction

```sh
npm ci --no-audit --no-fund
node scripts/fetch-programs.mjs
npm test
npm run build:wallet
npm run build:chain
npm run build:site
npm run verify
```

The program snapshots are verified by SHA-256 before use. If Metaplex upgrades a program, review the change before updating the expected hash. Tests use LiteSVM with real Devnet program binaries. They do not establish that a physical Phantom installation signed successfully.

Private collection commands accept local paths and never upload source art:

```sh
python3 scripts/collection/verify-plan.py --inputs SOURCE.zip --checkpoint CHECKPOINT --output private/plan-report.json
node scripts/collection/verify-car.mjs COLLECTION.car CHECKPOINT
node scripts/collection/repack.mjs COLLECTION.car CHECKPOINT private/release-v2
node tests/full-supply.mjs private/release-v2/reveal-map.PRIVATE.json
```

Do not commit `private/`, source layers, final CIDs, reveal arrays, wallet files or collection archives. Before public launch, use a production RPC and complete the owner's real Devnet signing flow. Marketplace indexing is a separate external step after deployment; no Magic Eden listing is claimed by this implementation.

Official references checked for this implementation:

- [Metaplex Core Candy Machine creation and Hidden Settings](https://www.metaplex.com/docs/smart-contracts/core-candy-machine/create)
- [Core asset updates](https://www.metaplex.com/docs/smart-contracts/core/update)
- [Phantom sign-and-send transactions](https://docs.phantom.com/solana/sending-a-transaction)

Dependency scan: no high or critical advisories at the build checkpoint. Remaining moderate advisories stem from the SDK's server-side streaming JSON dependency; the browser bundle does not use its TCP parsing path. They remain tracked and are not described as fixed.
