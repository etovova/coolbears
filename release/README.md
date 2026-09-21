# CoolBears — official SDK release

Isolated rebuild, not deployed to the public website.

Install: `npm ci --prefix release --ignore-scripts`.
Verify official instruction construction: `npm run --prefix release verify:settings`.

Verified on 2026-09-21:

- All 454 original source layers, 10,000 unique trait combinations, exact scores,
  displayed scores, ranks and metadata frequencies: `reports/plan.json`.
- All 10,000 PNG files, their decoded 2000×2000 pixels, all 10,000 JSON files,
  77,258 CAR block reads and the full archive checksum: `reports/assets.json`.
- Official program binaries freshly read from finalized Devnet:
  `reports/programs.json` records addresses, slots and SHA-256 checksums.
- Local LiteSVM execution: collection and item creation, machine capacity 9,999,
  closed mint rejection, 0.5 SOL payment, duplicate asset rejection with no second
  payment, closing sales again, transfer and a synthetic metadata update:
  `reports/runtime.json`. This is **not** a real Devnet or physical Phantom test.
- Real Devnet preflight: genesis and three executable programs verified. The
  disposable test payer has zero test SOL. No real Devnet transaction was sent:
  `reports/devnet.json`.

Twelve transaction-journal fault checks passed: concurrent repeated calls, signature rejection, simulation
failure, persistence failure, lost send response, confirmation timeout, status
outage, processed-only status, on-chain failure, failed account read and restart
after later state changes. See `reports/journal.json` and run
`npm run --prefix release verify:journal`. The transport is simulated; these are
not a physical Phantom or network test.

## Extended audit on 2026-09-21

The source, archive and runtime checks were independently reviewed and extended.
Concurrent calls for the same journal step previously submitted twice. They now
share one in-flight promise, including signing and submission; rejection releases
the lock for an explicit retry. The durable receipt still protects restarts.

- `reports/plan.json`: original SHA-256 and dimensions of all 454 layers,
  every layer-to-trait mapping, body/mouth matching, saved fixed counts and all
  10,000 exact/displayed scores and ranks recomputed.
- `reports/metadata.json` and `archive-links.json`: all 10,000 exact image and
  reveal links, canonical reveal commitment, seven unique attribute categories,
  and actual CAR child-directory CIDs checked without publishing private values.
- `reports/archive-recheck.json`: all 12,763,395,054 archive bytes rehashed and
  matched to the archive fully decoded in `assets.json`; the unchanged PNGs were
  not needlessly decoded a second time.
- `reports/runtime.json`: 72 local checks, including 51 paid mints from one
  wallet, insufficient payment, incorrect treasury, unauthorized guard/metadata
  changes, former-owner transfer rejection and a one-item sellout boundary.
  These are individual transactions, not a 50-NFT browser order acceptance test.
- `reports/browser.json` and `live-site.json`: languages, quantity limits,
  closed mint, wallet chooser, all 26 public content files and eight retired
  URLs checked. CNAME is deployment configuration, not a required content URL.
- `reports/dependencies.json`: narrow bn.js and uuid fixes installed in the
  release lockfile, then all 90 SDK/journal/runtime checks rerun successfully.

Real Devnet execution remains blocked on test funds. The audit's bounded RPC
airdrop request returned 429; the official web faucet then requested Cloudflare
CAPTCHA. No issuance transaction was sent. Physical Phantom signing and Magic
Eden indexing remain separate unfinished checks.

The next gate is real Devnet execution. Test payer:
`BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF`.
It needs approximately 1 **Devnet** SOL; never send mainnet SOL. Official faucet:
https://faucet.solana.com/. The key is private/devnet-lab.json and is disposable;
it has no connection to the owner's wallet. The disposable key is also saved privately in the continuation backup. Restore
that key and journal together if the local working directory is lost. Never use
this public test address for real funds.

Run with a stable Devnet HTTPS RPC:
`COOLBEARS_DEVNET_RPC='https://your-devnet-rpc' npm run --prefix release test:devnet`.
The optional `COOLBEARS_LAB_CURL=1` transport honors a hosted environment's proxy;
it belongs only to this Node test, not to a browser wallet application.

The Devnet runner writes each signed transaction before sending and never
automatically replaces an unresolved transaction. Restarting checks saved
signatures. A previous verified step is historical evidence; the final account
state is rechecked after the whole sequence. A stopped run remains stopped until
its receipt can be resolved. Neither a timeout nor a simulation is a success.

To reproduce private-file checks (Python with Pillow required):

```sh
python3 release/verify-plan.py PRIVATE_REFERENCE_DIR PRIVATE_METADATA_DIR SOURCE_ZIP
node release/verify-assets.mjs COLLECTION_CAR PRIVATE_REFERENCE_DIR PRIVATE_METADATA_DIR
```

These paths are private inputs, not URLs or public repository files. No private
traits, artwork, reveal CIDs or signing keys are included in the reports.

To reproduce the local program test:

```sh
npm run --prefix release fetch:programs
npm run --prefix release verify:runtime
```

The owner-facing workflow and physical Phantom acceptance test are pending the
network test. This directory is not included in the website build. Sales remain
closed; the lab opens only its separately named disposable test collection.

The checked source decisions are in SOURCES.md. The settings report explicitly covers offline SDK construction only. Real Devnet execution, the physical Phantom wallet, and marketplace indexing are separate gates.

Private artwork and test keypairs stay in the root private/ directory. Never commit them. No owner seed or private key is required.

Dependency note: Core Candy Machine 0.3.0 currently declares older Umi peer
ranges in its transitive Token Metadata/toolbox dependencies. npm reports these
warnings. The lockfile is pinned and the selected Core flows passed construction
and program execution; unused guards and plugins are not certified by this test.
