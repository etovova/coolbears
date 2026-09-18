# Creator reservation

The new contract reserves token #0000 for the immutable treasury address, currently
`0:6ea2cc995c7d4f236441c6c520b236c3e919ec54e331b4269528428c651a5717`.
Changing the administrative owner or royalty destination cannot redirect this claim.
The creator pays the same mint price plus deployment reserve. The user signs the claim.

`RSV0` (`0x52535630`) followed by a 64-bit query id claims exactly one NFT. It is
allowed while public mint is paused, only from the treasury and only at index zero.
Ordinary `MINT` cannot allocate zero even if the owner has unpaused prematurely.
After claiming, ordinary mint starts at one; the total supply remains 10,000.
`get_creator_reservation` returns the claimed flag and beneficiary address.
The unsigned build package includes a testnet-only claim request. Add a fresh
`validUntil` timestamp immediately before signing. Never send it to an old contract.

## Private final generation

Once the original layers have been generated into 10,000 distinct candidate records
with `image` and `attributes`, run:

    node scripts/reserve-rarest.mjs /PRIVATE/candidates.json /PRIVATE/new-reserved-output

The output directory must be new and outside this repository. No upload occurs.
Every record must have the same trait categories (use explicit `None` values).
Scores are the sum of supply divided by the observed frequency of each trait value.
Exact rational arithmetic avoids floating-point tie errors. A unique maximum is
required; if the maximum is tied the process fails, with no artificial score bonus.
The highest-scoring artwork and its metadata are assigned to token zero together.
The remaining assignments, ranking and top 50 stay private until reveal.
This is the collection's own score; other marketplaces may use different formulas.

The on-chain contract guarantees the recipient, not the truth of off-chain artwork
or ranking. The private generation check must run on the actual final candidates
before publishing the final root. Original layers are still outstanding; no real
10,000-piece artwork set or rarity ordering has been generated yet.

## Disclosure and rollout

Public collection copy is maintained in metadata/collection.json.
Its artwork and traits remain hidden. The reservation itself is not secret: observers
can identify the reserved token and infer its intended rank. Do not describe public
mint as giving buyers a chance at the collection's number-one NFT.

Existing `testnet/locked/deployment.json` and the deployed collection remain unchanged.
This source change produces a new address and needs a separate deployment to test
on-chain. Mainnet remains disabled. Final collection description/CID must be approved
and pinned before mainnet deployment; the reveal lock also gates description changes.
