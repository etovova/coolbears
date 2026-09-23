# Closed Devnet preparation, blockhash provenance and mint costs

PR44 extends PR43. Sales remain closed, price 0.2 SOL. The generated gateway
still disables submission; no route, Worker, secret, site or live deployment
was changed. All new executions use intercepted RPC and disposable test keys.

## Original blockhash

Before an asset signature, use `createBuyerPreparationClient()` with the fresh
revision-0 order already durably created in buyer storage. The fixed HTTPS POST
`/api/buyer/prepare` accepts only version, nonce and that order. The gateway
requires the pinned deployment and approved owner buyer. It reads Devnet genesis,
`getLatestBlockhash` at confirmed commitment, and the current block height with
that source slot as `minContextSlot`. At least 80 blocks must remain.

The exact unsigned SDK candidate and an anchor containing immutable order
identity, message hash, blockhash, original lastValidBlockHeight and source slot
are committed to the existing SQLite object and read back before the response.
The stable per-asset key includes cluster/machine/collection/guard/buyer/asset;
it excludes caller order ID. A conflicting identity is refused. No private key
or signature is generated or stored by the gateway.

An explicit repeat of the same preparation restores the original candidate
without a new RPC/hash, including after browser/server restart or a lost reply.
The restored preparation is not a freshness grant. There is no automatic retry,
refresh, replacement, deletion or expiry-based release. If its hash is now old,
the later check blocks; a reviewed abandoned/expired-attempt workflow is still
needed. Server preparation itself does not mutate the browser journal.

The browser validates the returned candidate by exact SDK reconstruction, then
passes `report.candidate` to `store.prepareAssetSigning(scope, candidate)`.
Existing durable asset-signing and wallet-claim rules remain in force. After
preparation, callers must respect gateway spacing/cooldown; no automatic HTTP
retry was added. The usual fresh check remains mandatory before wallet signing
and again for the explicit test-enabled send route.

Checks and sends require the anchor read from server storage, and reject missing,
corrupt, mismatched or caller-inflated lifetime information before upstream work.
They never call getLatestBlockhash. Fee/simulation/final validity queries use a
context at least as recent as the original source slot. Current hash validity
and an 80-block remaining lifetime are independently checked. Finalized account
reads may trail that confirmed slot; they retain their own finalized floor.

The structural validator is not an authentication mechanism. Only the trusted
server dependency can supply its persisted anchor to the checker; HTTP callers
cannot supply one. Old unanchored prepared/signed attempts stay blocked for
signing/submission. Read-only finalized recovery remains available without an
anchor and never upgrades missing provenance into retry permission.

Preparation shares the existing global daily quotas, serialized work and durable
cooldown/uncertainty hold. A restored response performs no RPC and does not charge
a new check. Origin remains an origin boundary, not caller authentication.
Permanent records currently have no cleanup/retention migration.

## Cost contract

The exact first-item template has two signatures, a 300000 CU limit and no
compute-unit price instruction. The checker quotes its actual message fee and
base asset rent from RPC and includes the Core create charge of 1500000 lamports.
It requests the simulated new asset account explicitly. Its Core program owner,
non-executable status, lamports equal to rent plus protocol charge, and exact
serialized base-account shape must match the approved hidden metadata, owner and
collection. Missing simulation account data, additional plugins/bytes, a changed
charge or an unexpected allocation blocks the check. Nothing defaults to zero.

`budget.complete=true` has scope `next-item-current-template`: price + quoted
message fee + asset rent + verified Core charge. Priority fee is explicitly zero
for this fixed template. The balance must cover this first-item total both before
and after simulation. The quoted price remains included even in the closed test
profile where buyer and treasury coincide; it is a conservative gross budget,
not a measured net wallet debit.

`projectedOrderTotalLamports` multiplies that total by quantity (1–50), using
integer lamports. `projectionOnly=true` and `fullOrderTotalLamports=null` prevent
claiming an exact price or sufficient balance for all future transactions. Each
later item/retry needs a fresh quote and balance check. Failure fees, owner
setup/reveal, external services and Mainnet calibration are separate. Simulation
is not an execution guarantee or a public purchase grant.

Wallet handoff now requires the provenance flag and complete first-item scope.
A successful prepared report still grants only the closed Devnet sign-only step;
send is separately disabled by default and recovery still needs finalized proof.

## Verification and next work

Node covers missing provenance, restored original bytes, inflated lifetime with
otherwise-valid identical wire signatures, identity conflict, ambiguous/corrupt
storage, shared quotas, altered HTTP reports, complete-cost arithmetic, balance
shortfall, missing/mismatched simulated accounts and downgraded wallet reports.
Old quota/sender tests explicitly inject trusted fixture anchors; separate new
preparation tests exercise real gateway creation without injected records.

The workerd suite now creates preparation through RPC and restores it after a
real SQLite restart. Chromium follows actual HTTPS preparation → durable asset
partial → checked wallet → saved response → claimed send → finalized recovery,
and tests a browser/server crash between preparation and asset signing. All RPC
is intercepted. Chromium results are confirmed in CI, not inferred from bundling.

Remaining: reviewed retry/abandon handling, subsequent order items, durable
custody recovery policy, user-facing cost approval, actual private setup and
reviewed purchase UI. Real bundle/password/RPC configuration is still absent.
Never merge/deploy/open sales or request a real signature as part of these tests.

Primary references checked on 2026-09-23:
- https://solana.com/docs/rpc/http/getlatestblockhash
- https://solana.com/docs/rpc/http/simulatetransaction
- https://www.metaplex.com/docs/smart-contracts/core/faq
- https://www.metaplex.com/docs/protocol-fees
