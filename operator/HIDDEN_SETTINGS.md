# Closed Hidden Settings launch candidate

The previous candidate allocated 871,827 bytes and inserted 9,999 complete
config lines in 1,428 transactions. This opt-in profile allocates 652 bytes and
uses three unsigned deployment transactions. The exact previous PR60 commit
`31bd15910e5f9ca1d6c77efa71e45ab000707abd` is preserved by
`preserved-config-lines-pr60-20261003`; default v1 preparation and existing
custody, journals, order records and public asset bytes remain supported.

Sales remain closed at 0.2 SOL. This change does not merge, deploy, create a
real custody bundle, sign a real wallet transaction, send to Solana, or repeat
the completed Devnet lab. Existing collection/machine accounts are not changed.

## Preparation and funding

The operator must first generate the content commitment using the explicitly
supplied approved private final mapping and unchanged original PNGs. See
[reveal/README.md](reveal/README.md). No fixture hash is a production hash.
Preparation accepts explicit `storageMode:'hidden-settings'` and
`hiddenCommitmentSha256`. The persisted CLI JSON uses exactly 32 numeric hash
bytes; manifest and public profile use lowercase SHA-256 hex. Canonical intent
is rebuilt with the pinned official SDK and all authorities/closed guards.

The new plan contains collection creation, the separate internal asset, and
machine/guard creation. No `addConfigLines` call is needed. Hidden Settings
cannot convert or refund the already existing config-line machine in place.
This is preparation for a separate future deployment.

Historical public Devnet program binaries, clock and rent from September 23
were replayed in LiteSVM with local blockhashes and signature verification
disabled. The three actual program executions consumed:

| Component | Lamports | SOL |
| --- | ---: | ---: |
| Account rent | 8,656,320 | 0.008656320 |
| Core creation charge | 1,500,000 | 0.001500000 |
| Three two-signature transaction fees | 30,000 | 0.000030000 |
| Total simulated preparation | 10,186,320 | 0.010186320 |

This is a reproducible historical model, not a fresh Mainnet budget or a
funding instruction. Priority fees, retries, service usage and later internal
asset operations are excluded. Initial accounts need funds before a buyer can
mint. There is no assumed sponsor or way to charge a not-yet-existing mint
transaction for this initial setup.

## Buyer payment

The buyer is the transaction fee payer, minter and NFT owner. The quote includes
0.2 SOL to the approved destination, current message fee, a maximum-width NFT
account rent reserve and the Core creation charge. Hidden indexes can acquire
more decimal digits after a preflight check: the budget therefore uses the
serialized size for the largest permitted index and a fresh RPC rent quote.
Simulation still verifies the actual current index, exact account bytes and its
actual rent separately. A changed index during the check still blocks progress.

The reserve changes the balance/approval budget, not the transaction or amount
collected. The mint program charges only the actual account rent; any unused
reserve remains in the buyer wallet. No owner-funded mint subsidy, additional
purchase surcharge or platform tip is added. The default v1 quote is unchanged.
This remains an application estimate and approval ceiling, not an on-chain
spending cap; the reserve covers index-width growth under the verified profile,
and fresh selected-network program and fee checks are still required.

Version 2 orders bind the chosen storage profile and commitment. Their durable
storage namespaces are distinct from v1, so old records remain recoverable.
Wrong profiles, stale mint indexes and mismatched asset bytes block progression.
Each subsequent item is checked after the preceding finalized receipt;
a fifty-item projection does not promise future fees or available balance.
See [orders/HIDDEN_SETTINGS.md](orders/HIDDEN_SETTINGS.md).

## Same-URI public reveal

Stable decimal on-chain names use `CoolBears #1`; approved JSON names retain
`CoolBears #0001`. The indexed URI never changes. A small hosting Worker aliases
indexed requests to existing padded JSON files, avoiding another 9,999 files.
The closed candidate has 10,032 asset files and a small Worker bundle; it does
not require a paid asset-count tier merely for the aliases.

Final JSON is prepared privately, only after explicit reveal authorization and
the policy date, matching the pre-mint content commitment and original PNG
hashes. The Worker checks exact approved placeholders by default. Final mode
also requires a separately reviewed deployment configuration that pins the
commitment and proof bytes. Encoded URL aliases, nested private fields, altered
proofs/documents and premature requests fail closed.

Replacing the public JSON responses at the same URIs avoids 9,999 on-chain
metadata updates. This is a custom off-chain process rather than Metaplex's
example that changes every asset's name/URI. The internal allocation remains
outside that public reveal package and may need a separate owner operation.

The domain and stored images still need to remain available. Wallets and
marketplaces may cache the placeholder or display the on-chain decimal name;
their refresh behavior has not been verified. Hosting remains the metadata
authority, and the content commitment allows later verification rather than
making the endpoint immutable.

## Remaining expenses and readiness

Free infrastructure tiers can be used within their actual limits. Worker
requests and CPU count for the new route, including static fallback; local
tests do not establish the Cloudflare free CPU/request quota fit under launch
load. Domain renewal, final storage, RPC and possible service overage remain
separate. No subscription upgrade or billing setting was changed. Later
operating bills can be funded from the existing 0.2 SOL sale proceeds; no new
buyer fee was introduced. Completely zero initial owner funding is not assumed.

The actual private mapping, custody directories, fresh selected-network program
and fee reads, unsigned live simulation, real wallets/physical phones, storage
availability and marketplace refresh remain unverified. Fixtures and local VM
funds do not satisfy these requirements. Public UI sales and all production
send entry points remain disabled.

Validation evidence: `reports/hidden-isolated-20261003.json`; new Node tests;
hidden owner workerd/SQLite tests; the metadata Worker runtime; and the new
Chromium buyer-console test. CI must record its final results on the new head.
