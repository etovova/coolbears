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

### Buyer-triggered Testnet pilot

The loopback storefront exercises one new NFT requested by one designated disposable Testnet buyer. The first Mint click signs an issuer transaction that creates slot 0001 and its 10 test XRP sell offer. Only the designated buyer can accept the offer. Accepting exchanges the NFT and the price in the same transaction. Dismissing the wallet leaves the NFT with the issuer and allows the same buyer to return. A completed purchase exhausts this pilot.

The pilot uses Node.js 24, Python 3 with `xrpl-py==5.2.0`, the isolated issuer and buyer addresses in `testnet_mint.py`, and the issuer's previously validated slot 0000. The operator supplies `CB_PILOT_PYTHON`, `CB_PILOT_SEED` (the disposable Testnet issuer's owner-readable seed file) and `CB_PILOT_STATE` (a private directory outside Git). Run `node --use-env-proxy xrpl/testnet-pilot.mjs` and open `http://127.0.0.1:18840`. The separate server accepts local same-origin requests only. It uses the ordinary storefront to recheck the validated offer and receipt. The public Worker has no mint endpoint.

Each retry uses the signed bytes and transaction hash committed to the pilot's SQLite journal before submission. An expired, unresolved transaction stops issuance. Preserve the journal across restarts. The pilot has no automatic reassignment or cancellation of abandoned offers. A public rollout requires an issuer signing arrangement, authenticated requests, limits on outstanding offers and a policy for returning abandoned tokens to sale.

### Expiring Testnet reservations

Set `CB_PILOT_RESERVATIONS=yes` on the loopback storefront to use slot 0002 with two allowlisted test wallets. It issues the slot once against a three-minute offer. A repeat request by the same wallet recovers its existing offer. During the reservation the second wallet receives HTTP 409. In the last 60 seconds the storefront stops initiating new signatures for that offer. The ledger close time governs expiry.

A request after expiry cancels the old offer and creates a new buyer-specific offer for the same NFT after confirmation. The service checks validated ownership and the original URI, price and transfer settings. If an offer was removed externally it checks the ledger history before offering that token again. A purchase exhausts the slot. The isolated test has a lifetime budget of six offers, serializes issuer operations across processes and saves each signed transaction before submitting it. Keep the private journal. Public hosts expose no issuer signer. Public rollout still requires buyer authentication, a production signing arrangement and collection-wide inventory controls.

### Marketplace domain identity

The canonical domain serves its Mainnet issuer at `/.well-known/xrp-ledger.toml`. For Bithomp and other readers, GET and HEAD on this exact path must return TOML with `Access-Control-Allow-Origin: *`. The unsigned [account domain template](launch/set-domain.json) contains the matching domain for the issuer to review after account activation. Two-way verification requires the matching Domain on the validated Mainnet account. A marketplace profile or verification badge has its own approval process.

Run `python xrpl/test_reservations.py` with the Testnet pilot dependencies for expiry, contention, recovery and sold-token regression checks.

### Collection orders and recovery on Testnet

The collection pilot manages 10,000 numbered slots in a private SQLite journal. On the dedicated Testnet issuer, slots 0000–0002 belong to the earlier experiments. A wallet signs a short-lived message naming the site, Testnet, price and persistent order ID. The browser stores this ID before the mint request. GemWallet and CROSSMARK can produce the message signature separately from the payment signature. The pilot verifies the address and signature and checks that the master key is enabled. The default permits the two designated test buyers. For an independent funded Testnet wallet, enable CB_PILOT_OPEN_BUYERS=yes on the loopback storefront and start a fresh issuer authorization with --all-test-buyers. Both settings are required. The account still signs the order and the buying transaction.

The allocator records one active order per wallet and slot. Repeating the same order recovers its offer or receipt. It reuses previously issued tokens after a confirmed offer removal. A validated sale permanently consumes the slot. An unsigned draft is saved before requesting a signature. The issuer transaction hash, signed bytes and ledger window are saved before submission. Missing history keeps the order pending. Rebuilding an empty database against an issuer with a different issuance count stops further mints.

The collection storefront requires an issuer agent and runs without an issuer seed. The issuer agent accepts fixed-price Testnet mints, buyer-directed listings of approved tokens and cancellation of expired offers. Its signing budget is an inclusive range of slots. It checks the Testnet account sequence and deadline and records each approval before answering. Requests and responses use a private local inbox. A storefront can validate each response against the exact draft and issuer public key. Host permissions and isolation of the signer must be provided by the operator. A new agent journal permits at most twelve signatures per authorized slot across all transaction types. Keep both journals on durable storage. Each directory and the seed file used in this Testnet example must be private to the operator.

The following example uses paths outside Git. The working state starts with the three prior slots accounted for. On an existing journal, select the verified next unused slot when starting a *new* agent signing journal. Reuse the same journal and budget on restart.

```sh
# Issuer agent process, sole holder of the disposable Testnet seed.
CB_SIGNER_INBOX=/private/signing-inbox python xrpl/testnet_signer.py \
  --state /private/issuer-state --seed /private/testnet-issuer-seed --first 3 --last 8

# Storefront process. Give it its own state and the inbox, without the issuer seed.
CB_SIGNER_INBOX=/private/signing-inbox CB_PILOT_STATE=/private/storefront-state \
  CB_PILOT_COLLECTION=yes CB_PILOT_PYTHON=/path/to/venv/bin/python \
  node --use-env-proxy xrpl/testnet-pilot.mjs
```

Both services run on the operator's machine. Direct the browser to the loopback URL printed by the storefront. Wallet adapters, the address allowlist and network checks pin this implementation to XRPL Testnet. The public Mainnet Worker has no connection to the signing agent. The [verified Testnet purchases](verification/sales-testnet.json) record the four published mint and sale hashes. Verify a recorded Testnet primary purchase independently with `python xrpl/verify_testnet_sale.py MINT_HASH PAYMENT_HASH`. The collection inventory test uses 16 concurrent writers and synthetic chain events to exercise all 10,000 slots. Live Testnet receipts cover individual NFTs. Run the offline Python checks with `python -m unittest discover -s xrpl -p 'test_*.py'` and the storefront checks with `node --test xrpl/worker.test.mjs`.
