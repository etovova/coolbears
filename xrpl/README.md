# CoolBears on XRP Ledger

The collection contains 10,000 slots numbered 0000 through 9999. A canonical NFT has the issuer configured in worker.mjs, taxon 20270201, TransferFee 7000 (7%) and a transferable NFT. Earlier Testnet tokens use HTTPS. The Mainnet candidate uses a per-slot ipfs:// URI. Before reveal its flags are 24 (transferable and URI-mutable). Tokens first minted after reveal use the final directory with flags 8 (transferable). A sale offer must ask exactly 10000000 drops. The buyer accepts that offer in GemWallet or CROSSMARK. The application checks the validated ledger before signing and verifies the final transaction before displaying a receipt.

Artwork becomes available at 2027-02-01T00:00:00Z. The Worker checks its own clock on every metadata and image request. A hidden response uses Cache-Control no-store. The existing HTTPS endpoint reveals automatically. For pre-reveal IPFS mints, the issuer must update each URI on ledger. The existing Xaman mint and offer grant does not authorize that update. Confirm the issuer signing and scheduling arrangement before enabling Mainnet sales. Wallets may independently cache the cover.

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

### WalletConnect for buyers

Build the self-hosted signing client before packaging the storefront (`cd xrpl/hosted-testnet && npm ci && npm run build`). Set `WALLETCONNECT_PROJECT_ID` to the public CoolBears app project ID on the storefront Worker and the Testnet orders Worker. Allow the two storefront origins in WalletConnect Dashboard. The additional wallet option stays disabled until a valid project ID is configured. Buyers can scan the local QR code in Joey or Bifrost. Only Testnet collection reservations request an offline proof before the NFT purchase prompt.

Portions © 2025 Reown, Inc. All Rights Reserved. The SDK bundle includes the WalletConnect Community License.

### Xaman

Set the public application UUID as the Worker's `XAMAN_CLIENT_ID`. Register both callback URLs under **Origin/Redirect URIs** in the Xaman Developer Console:

- https://coolbears-nfts.com/xrpl/
- https://testnet.coolbears-nfts.com/xrpl/

The browser uses OAuth authorization code with PKCE, keeps the short-lived token in the same tab, and opens the signing link returned by Xaman. Each purchase requires one NFTokenAcceptOffer signature on the selected network. After the buyer returns, the storefront verifies the transaction on the validated ledger. A missing client ID leaves Xaman visibly unavailable. For on-demand Testnet issuance, set the public ID on the orders storefront. When the buyer presses Mint, it checks the OAuth session against Xaman's JWT ping and userinfo endpoints for this application, buyer and Testnet. The private issuer returns a short-lived reservation proof bound to that order. The payment is signed separately in Xaman. Register the exact callback paths above, including the trailing slash. The site keeps the OAuth token in the browser tab and sends it only during session verification and calls to Xaman.

### First Mainnet mint

The [first NFT template](launch/first-mint.json) prepares slot 0000 with the hidden IPFS URI. Run the preflight before signing so the correct phase and content availability are checked. Its hidden artwork uses the same randomized allocation as every other slot. Minting this template creates no sell offer. Publish an offer for 10,000,000 drops as a separate launch action after the owner approves sales.

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

### Public on-demand Testnet storefront

The public test site at https://testnet.coolbears-nfts.com/ issues a reservation after a wallet signs a site- and order-specific challenge. A second signature accepts the personal offer for 10 test XRP. A fresh browser can recover its wallet's active order. Receipts for the previous Testnet issuer still resolve through the original Worker.

The two Worker configurations in `xrpl/hosted-testnet` cover the Testnet API and browser script. The issuing Worker has no public route. The private Worker holds an Ed25519 delegate key, the reservation challenge key and the SQLite Durable Object binding. The issuer authorizes NFTokenMint and NFTokenCreateOffer through DelegateSet. The Worker signs fixed-price, buyer-directed sell offers. The ledger permission for NFTokenCreateOffer also covers buy offers. After expiry, the delegate cancels the old offer from its own account. Its order journal keeps the signed transaction bytes before submission. It looks up the same hash after a retry. A replacement requires complete ledger history and an unchanged sequence for the account named in the saved draft. Expired offers are reconciled before their NFT returns to inventory.

Build with Node 24 using `npm ci && npm test && npm run build` in that directory. Keep the existing issuer Worker, SQLite namespace, migration tag, object name and secret bindings when updating the deployment. The initial CHECKPOINT secret is a deflated, base64-encoded JSON export of the settled pilot's setup, occupied slots, orders and signed transactions. The bootstrap runs once per fresh database. Recover subsequent orders from the live namespace and its recovery history. The fixed Testnet issuer and network are part of the source.

With the owner’s chosen Mainnet operational address, run `python xrpl/prepare_delegate.py authorize PUBLIC_ADDRESS` to print the unsigned grant or use `revoke` to print its revocation. An authorization replaces the entire permission list for that account pair. Review the two NFT permissions and the source account before signing in the owner’s wallet. The existing domain transaction is in `xrpl/launch/set-domain.json`.

The [public checkout record](verification/hosted-testnet-sale.json) contains the original mint, confirmed payment and ledger number. The browser test used a disposable wallet adapter. It reserved the NFT, resumed the offer after an issuer deployment in a fresh browser, completed payment and recovered the receipt on replay.


### Rarity after reveal

Each revealed metadata response links to its public card via `external_url`. The card accepts the four-digit mint number from the metadata URI, shows the original artwork and rank, and lists the collection count and percentage for each of the seven traits. The percentage labeled “Top” is the rank divided by 10,000 and expressed as a percentage. For example, rank 100 is in the top 1%. The original rarity score and trait-frequency data are preserved. Before the server's reveal time, metadata contains only the hidden name, description and cover. The card is available in English, Russian and Chinese.

### Pinata and IPFS release

Build with Python, the same allocation seed used by the Worker, the verified original archive, and ipfs-car 3.1.0. All output belongs outside Git. Each build writes a CAR archive and its single-root CID in a local report.

```sh
python xrpl/ipfs_release.py hidden /private/release
python xrpl/ipfs_release.py revealed /private/release --originals /private/parts --allocation /private/allocation
```

Before reveal, only `hidden.car` is public material. It contains all numbered placeholder files and the original GIF. Importing it as a CAR pins the directory and its cover. Check that Pinata finishes importing the expected root, then retrieve a numbered JSON and its image by CID. Uploading a CAR as an ordinary binary produces a different CID. Pinata's documented CAR import requires a paid plan and the public network.

Keep the final metadata CAR, manifest, original CAR and assignment private until the reveal boundary. At reveal, pin the original CAR root (the 28 ZIP parts carry a single CAR stream) and the final metadata root. JSON image references are strings; pin both roots independently. Maintain a second independent pin or node for availability. After public retrieval succeeds, set IPFS_REVEALED_ROOT for the storefront offer check. Before signing each URI update, fetch current token state and simulate:

```sh
python xrpl/ipfs_nft.py NFT_ID SLOT /private/release/revealed.json
```

This command prepares an unsigned NFTokenModify for the current owner and skips tokens already updated. Transferring a token during signing can invalidate the draft; reread its owner before retrying. The issuer can change a mutable token's URI again. The Mainnet first-mint preflight accepts `--reveal-report /private/release/revealed.json` for an initial mint after reveal.

[XRPL NFT storage](https://xrpl.org/docs/concepts/tokens/nfts/payload-storage) · [Dynamic NFTs](https://xrpl.org/docs/concepts/tokens/nfts/dynamic-nfts) · [IPFS persistence](https://docs.ipfs.tech/how-to/best-practices-for-nft-data/) · [Pinata CAR import](https://docs.pinata.cloud/files/uploading-files#upload-by-car-file)
