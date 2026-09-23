# Stateful deployment simulation

This stage runs the canonical 1431 unsigned preparation messages in **LiteSVM
1.4.1**, an in-memory Solana VM. State persists between operations: collection,
one reserved asset, machine and guard, then 1428 batches containing all 9999
public config lines. There are no buyer mint instructions.

```sh
npm ci --prefix operator --ignore-scripts --no-audit --no-fund
npm run --prefix operator setup
node operator/deployment/isolated-cli.mjs
```

The command reads the official public Devnet RPC. It downloads the three
executable Metaplex programs and Rent/Clock sysvars from one finalized bank,
validates their loader/account bindings, and records program-data addresses,
deployment slots and SHA-256 hashes. `program-snapshot.json` preserves the
public executable bytes for replay. No owner account or private metadata is
downloaded. No Helius/Cloudflare configuration is involved.

Output is written with exclusive creation to
`operator/build/isolated-deployment/{program-snapshot,report}.json`. Existing
reports are not overwritten. Move the prior output directory before another
run. The workflow saves both files as a 14-day artifact; permanent reviewed
reports live in `operator/reports/`.

## Boundaries

- Only the RPC read allowlist is available; simulation RPC, broadcast, faucet,
  signing, wallet access, production key generation and journal writes are absent.
- `LiteSVM.sendTransaction` changes **local process memory only**. Its name does
  not mean submission to Solana. A test runs local transactions with `fetch`
  prohibited and verifies persisted balances and failure rollback.
- The owner public address is retained. Its balance is seeded with artificial
  test funds. New account addresses are public curve points without secret keys.
- Signature verification is disabled. Duplicate-signature history is disabled
  because all signatures are zero. Local blockhash checks remain enabled. A local
  hash is used, never a live signing request; no owner authorization is proven.
- Program bytes, Rent and Clock come from Devnet. The VM's default feature set,
  builtins and other sysvars are **not proven equal to the live validator**.
  This is not whole-chain RPC simulation, consensus/finality, Mainnet validation,
  physical-wallet testing or evidence that transactions will be included.
- Price stays 200000000 lamports; owner AddressGate remains installed. Public
  sales stay closed. No public NFT is minted and no real SOL is spent.

## Checks and cost evidence

Canonical intent is rebuilt with the existing official SDK. All unsigned message
bytes and required signer counts are preserved. The VM must execute every step
successfully. Existing account verification checks the first three transitions
and the final state, including the complete 9999-line prefix, bitmap, mint
indices, authorities, 7% royalty, unchanged asset ownership and exact guards.
Each checkpoint's actual account sizes must match the model.

For every message, payer debit and the net balance change across **all writable
transaction accounts** are measured. Their difference accounts for transfers
versus runtime fees. Modeled rent/charge amounts must reconcile per step and
against final account balances. The Core charge is visible as the reserved
asset balance above rent; it is not a separate second rent charge.

Rent is calibrated against live RPC for all five modeled sizes. Four
representative message fees are compared to current Devnet quotes under a valid
blockhash. This does **not** re-quote every message; PR25 has the separate 1431
message preview. A rent/genesis mismatch, expiry or rate limit blocks the report
without retries or endpoint fallback. Program hashes describe the captured bank;
the programs are not re-downloaded after execution.

`budgetComplete=false` and `fundingRecommendationLamports=null` remain explicit.
Buyer mints, reveal, hosting/storage/domain/RPC subscriptions and SOL exchange
rates are excluded. A new production bundle and fresh network checks are still
required before any future owner signature.

## Guard verification correction found by execution

The installed Core Candy Machine SDK 0.3.0 has two account serializers. Its
generated `CandyGuard` header uses `[44,207,199,184,112,103,34,181]`, matching
`sha256("account:CandyGuard")[0:8]` and the deployed program. The hooked account
serializer incorrectly forces `[95,25,33,117,164,206,9,250]` during serialization.
Synthetic round-trip tests previously reproduced that incorrect prefix and
therefore rejected a real Guard after machine creation.

The verifier now combines the official generated header with the official guard
data serializer, comparing **all** bytes. The incorrect discriminator is rejected.
A 157-byte fixture emitted by the captured program covers this regression, and
the complete isolated workflow exercises the actual program again. No dependency
source is patched and no guard constraint is loosened.

Primary references checked for this stage:

- [LiteSVM configuration](https://solana.com/docs/tools/litesvm/typescript/api-reference/configuration)
- [LiteSVM transactions](https://solana.com/docs/tools/litesvm/typescript/api-reference/transactions)
- [LiteSVM Node wrapper](https://github.com/LiteSVM/litesvm/tree/master/crates/node-litesvm)
- [UpgradeableLoaderState layout](https://docs.rs/solana-loader-v3-interface/9.0.0/src/solana_loader_v3_interface/state.rs.html)
- [Pinned Metaplex CandyGuard Rust account](https://github.com/metaplex-foundation/mpl-core-candy-machine/blob/ea3620b7436004f62e1e7bc3d69147f4feef2ae0/programs/candy-guard/program/src/state/candy_guard.rs)
