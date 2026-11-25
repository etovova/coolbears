# CoolBears on XRP Ledger

The collection contains 10,000 slots numbered 0000 through 9999. A canonical NFT has the issuer configured in worker.mjs, taxon 20270201, the transferable flag (8), TransferFee 7000 (7%) and a permanent HTTPS URI ending in /xrpl/metadata/NNNN.json. A sale offer must ask exactly 10000000 drops. The buyer accepts that offer in GemWallet or CROSSMARK. The application checks the validated ledger before signing and verifies the final transaction before displaying a receipt.

Artwork becomes available at 2027-02-01T00:00:00Z. The Worker checks its own clock on every metadata and image request. A hidden response uses Cache-Control no-store. The new endpoint uses one immutable reference per token and requires no wallet signature at reveal time. Wallets may independently cache the cover.

## Preparing private assets

Use Python 3 with cryptography installed. Keep inputs, seed and output outside the repository. The seed is a 32-byte random collection allocation secret. Retain it securely to reproduce the same allocation and encryption. Never generate a replacement for an issued collection.

```sh
python xrpl/prepare.py ORIGINAL_ZIP_DIRECTORY PRIVATE_OUTPUT EXISTING_SEED
```

Preparation checks every ZIP part, the full original CAR, all referenced content hashes, each PNG's dimensions and chunk checksums, the 10,000 metadata pairs and the inclusion of the highest rank. The full allocation is a permutation. No slot is assigned to an owner. Shards and image ranges are independently authenticated with AES-GCM. The public repository contains no final metadata, private seed or artwork packages.

Register the generated manifest using the Cloudflare Workers assets upload-session API. Upload only the requested assets with the temporary session JWT.

```sh
python xrpl/upload.py ORIGINAL_ZIP_DIRECTORY PRIVATE_OUTPUT EXISTING_SEED SESSION_JSON COMPLETION_JSON
node --test xrpl/worker.test.mjs
```

The Worker needs the ASSETS binding, asset routing set to run the Worker first, and a secret ASSET_KEY whose base64 value is the storage_key output in prepare.py. The Testnet host uses NETWORK=testnet, a distinct TEST_ISSUER and SALES_OPEN=yes. The main domain uses the project address and has purchases disabled until a separate Mainnet release. Activating and minting from the project account requires its owner's authorization. No signing key is needed by this Worker.

The GemWallet browser bundle and its license are taken from @gemwallet/api 3.8.0. The cover and logo use the original collection assets.

### Xaman

Set the public application UUID as the Worker's `XAMAN_CLIENT_ID`. Register both callback URLs under **Origin/Redirect URIs** in the Xaman Developer Console:

- https://coolbears-nfts.com/xrpl/
- https://testnet.coolbears-nfts.com/xrpl/

The browser uses OAuth authorization code with PKCE, keeps the short-lived token in the same tab, and opens the signing link returned by Xaman. Each purchase requires one NFTokenAcceptOffer signature on the selected network. After the buyer returns, the storefront verifies the transaction on the validated ledger. A missing client ID leaves Xaman visibly unavailable.

### First Mainnet mint

The [first NFT template](launch/first-mint.json) mints slot 0000 into the issuer account with a permanent URI. Its hidden artwork uses the same randomized allocation as every other slot. Minting this template creates no sell offer. Publish an offer for 10,000,000 drops as a separate launch action after the owner approves sales.

Run `python3 xrpl/first_mint.py` when preparing the first signature. It reads a validated Mainnet ledger, checks the issuer's lifetime mint count, fixes the sequence, fee and expiry, and simulates the transaction. It emits an unsigned transaction only if the simulation succeeds. A fee above 100 drops pauses preparation for review. This check never signs or submits a transaction. If a previous signature has an unknown outcome, reconcile its hash with the ledger before requesting another signature. Re-run the check when the ledger window expires.

The reveal returns each original rarity rank, score and trait frequencies in `properties.rarity`. The existing Top 50 section loads its ranked list after the Worker opens `/xrpl/api/top50`. Its source file is encrypted and follows the same UTC release gate as the artwork. Machine readers of the NFT URLs need access to GET and HEAD on public metadata, artwork and the cover, including when the reader does not present a browser user agent.
