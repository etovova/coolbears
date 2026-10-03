# Private same-URI reveal candidate

This is an offline candidate for the `hidden-settings` storage profile. Existing
config-line preparation, deployment history and the Devnet lab are unchanged.
The public machine uses stable decimal names and indexed metadata URIs. The site
Worker aliases those URIs to the existing padded JSON paths, so the final JSON
can replace the placeholder response without updating 9,999 Core asset accounts.
This is a custom off-chain reveal process; Metaplex's official hide/reveal example
instead updates each asset's name and URI on chain.

No command here uploads, publishes, calls RPC, signs, sends a transaction or opens
sales. There is no automatic reveal. Earliest reveal remains January 1, 2027.

## Private input

Keep the real manifest and original PNGs outside Git in an owned POSIX directory
with mode `0700`, and files with mode `0600`. No wallet secret belongs in this
manifest. The CLI does not discover files or search for private inputs.

The manifest is `{version:1,kind:"stable-uri-private-reveal",owner,entries}` with
exactly 10,000 entries. Each entry has only:

- `index`: served bear identity, integer 0 through 9,999.
- `sourceIndex`: original-artwork index; these must form a full permutation.
- `rarityRank`: private integer from 1 through 10,000, with the internal reserved
  mapping validated against the required private reserve policy.
- `artworkSha256`: SHA-256 of the unchanged original PNG bytes.
- `document`: complete approved final JSON for that served identity.

The internal allocation mapping is validated privately and is never emitted as a
public document or indexed route. This tool does not invent a mapping or derive
rarity from PNGs. A real operator must supply the previously approved mapping and
ranking evidence. The distinct reserved on-chain name and URI remain unchanged;
removing its on-chain hidden name would be a separate owner operation.

Final JSON names retain `CoolBears #0001` formatting. Stable public on-chain names
use `CoolBears #1`: Hidden Settings index expansion does not pad decimal numbers.
The same number identifies the asset. Final documents must contain the PNG image
and matching `properties.files`, approved website, attributes, and no private
rank, score, source index, reserve or key fields. Approved ordinary rarity
attributes can appear only in this final document after the reveal gates pass.
Public rank ties are allowed; the private check requires the internal allocation
to be the sole rank-1 entry and does not invent a rarity calculation. Original images are read only.

## Commitment and proof

Canonical JSON recursively sorts object keys, retains array order, uses UTF-8,
and ends with a newline. The full approved final document's SHA-256 and original
PNG SHA-256 form an indexed leaf commitment. A second SHA-256 commits all 10,000
ordered leaf hashes, the approved policy and both public and internal on-chain
name/URI contracts. Private source indexes and ranks are excluded from the
public content commitment; the final index-to-document/image association is
committed. These private fields are still checked locally before staging.

After the reveal gates pass, a public proof contains the public indexes 1 through
9,999 with their document/artwork digests and one opaque anchor for the private
entry. Anyone can verify the public content commitment without receiving the
private document, source mapping or rank table. The private anchor's content is
not publicly disclosed or independently verified by that proof.

`analyzeRevealManifest` and `saveRevealCommitment` do **not** claim that supplied
artwork digests have been checked against PNG bytes. `prepareRevealPayload` and
`stagePrivateReveal` require explicit original-byte reads, hash every PNG, and
reject mismatches before writing any staging output. This proves byte equality
with the committed input; it is not a PNG rendering/rarity-generation audit or a
proof that a remote storage URI serves those bytes.

`prepareRevealPayload` additionally requires:

- A matching commitment hash recorded before mint preparation.
- A valid UTC timestamp at or after the policy's earliest reveal date.
- Explicit owner reveal authorization and acknowledgement that indexer refresh
  is not instantaneous.

It emits only 9,999 approved replacements for the existing padded JSON paths,
`content-proof.json`, and a runtime configuration bound to the exact proof bytes.
The proof digest lets the Worker check its trusted prepared proof in one SHA-256,
while full 10,000-leaf verification happens offline. `READY.json` is written last.
A failed staging write preserves partial files without adding READY; an existing
output directory is never overwritten. Staging is private and is not publishing.

## CLI

Generate and review the commitment now, using an explicitly supplied private
manifest and a **new** output directory whose parent is owned/private:

```sh
node operator/reveal/cli.mjs commitment private/reveal-manifest.json private/reveal-commitment
```

A future authorized staging command requires the expected commitment hash,
original PNG directory (four-digit index filenames), a new output
directory, and both explicit reveal flags. It uses the actual current clock:

```sh
node operator/reveal/cli.mjs stage private/reveal-manifest.json EXPECTED_SHA256 private/original-pngs private/reveal-staging --reveal --accept-cache-refresh
```

Do not enable or deploy a revealed Worker until its exact output, final image
storage, availability and live wallet/marketplace behavior have been verified.
The CLI prints only a bounded safe report or an error code, never private input,
attributes, final image URIs, local paths or filesystem exception messages.

## Costs and limitations

This candidate avoids individual public NFT on-chain reveal-update fees. Buyers
already pay the mint's Core creation costs, transaction fees and approved
0.2 SOL payment; this tool adds no extra purchase fee. New collection/machine
bootstrap rent and the separately created internal asset still need initial
funding before buyers can mint. A third-party sponsor could fund them, but none
is configured or assumed. Later hosting, storage or RPC bills can be covered by
mint proceeds rather than adding a new buyer charge. Free service tiers have
limits and are not a guarantee of permanently zero infrastructure cost.

The same domain/URI must stay available. Off-chain responses remain controlled
by the project's hosting authority. Wallets and marketplaces may cache the
placeholder, choose the on-chain decimal name, or need a refresh. The local code
cannot guarantee Magic Eden/Phantom/Solflare updates, remote image availability,
long-term immutability or that Worker CPU will fit a particular free tier under
real load. These checks remain explicitly incomplete.

## Official sources checked October 3, 2026

- https://www.metaplex.com/docs/smart-contracts/core-candy-machine/create
  (Hidden Settings index substitution, sequential minting and storage mode).
- https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guides/create-a-core-candy-machine-with-hidden-settings
  (official on-chain update reveal example and commitment validation).
- https://www.metaplex.com/docs/smart-contracts/core/json-schema
  (off-chain JSON image/attributes/name).
- https://www.metaplex.com/docs/smart-contracts/core/update
  (asset name/URI updates are separate chain instructions).
- https://docs.magiceden.io/reference/solana-overview
  (metadata API; no same-URI automatic-refresh guarantee established here).
