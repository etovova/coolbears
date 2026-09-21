# Official release foundation — 2026-09-21

This directory starts from the cleared website. It does not restore the rejected
owner panel, transaction code, or tests. The website remains closed.

## Sources checked

| Decision | Current official source |
| --- | --- |
| Core standard and Phantom/Magic Eden support | https://www.metaplex.com/docs/smart-contracts/core/ecosystem-support |
| Collection and royalties plugin | https://www.metaplex.com/docs/smart-contracts/core/collections/create |
| Hidden Settings and later reveal | https://www.metaplex.com/docs/smart-contracts/core-candy-machine/create |
| Complete Hidden Settings guide | https://www.metaplex.com/docs/smart-contracts/core-candy-machine/guides/create-a-core-candy-machine-with-hidden-settings |
| Browser wallet via Umi adapter | https://www.metaplex.com/docs/dev-tools/umi/getting-started |
| Reference wallet UI | https://github.com/metaplex-foundation/metaplex-nextjs-tailwind-template |
| CLI release examined | https://github.com/metaplex-foundation/cli/releases/tag/v0.4.3 |
| Public RPC limits | https://solana.com/docs/references/clusters |
| Magic Eden Core listing by collection address | https://help.magiceden.io/en/articles/6006558-how-to-list-your-nft-collection-on-magic-eden-using-creator-hub |

The latest npm versions checked on this date are pinned in package.json and
package-lock.json. The Core/Candy Machine/Umi packages are official Metaplex code.
Instruction construction uses their exported builders, without a custom on-chain program.

## Tool selection

MPLX CLI 0.4.3 was examined and its version/help executed. Its transaction commands
use a file signer or Ledger, not the owner's Phantom. Its USB dependency also
cannot initialize in this hosted environment. Do not label CLI transaction
execution as tested here. Use official Umi SDK and its wallet adapter for Phantom;
use a separate disposable file signer only for Devnet integration tests.

The reference website template is guidance for wallet integration, not evidence
that the existing site or the owner's mobile wallet has passed a test.

## Release requirements

Read approved public settings and text from ../metadata/policy.json. Collection
royalties are 700 basis points. The None ruleset does not restrict transfers and
does not enforce royalties against arbitrary external programs. Do not advertise
universal royalty enforcement.

Hidden Settings keeps final traits and artwork private. The commitment is derived
from approved private data; it is not a substitute for secure storage. There is no
on-chain reveal timelock in Core: the owner process must enforce the approved date.

The new release requires a reliable configured RPC. Public RPC is acceptable for
bounded developer checks, not proof of production availability. Do not rotate
public providers or hide rate limits in endless retry loops.

## Checkpoints

Save each completed stage in the official-release branch and update the existing
CoolBears_Collection.md. Keep private inputs, keypairs, signed test transactions,
final metadata and CIDs out of this public repository. A test may be called a
real Devnet pass only when its signature and fetched on-chain account state agree.
# Runtime verification sources

LiteSVM 1.4.1 is used only for a separate local execution check. Its installed
TypeScript declarations and implementation define the adapter:
https://github.com/LiteSVM/litesvm.

Program binaries are freshly fetched from finalized Devnet accounts and checked
against the recorded SHA-256 values. No binary or test from the deleted release
implementation is restored. The official faucet distinguishes real Devnet funds
from local validator balances: https://faucet.solana.com/.

## Dependency audit references

- bn.js fixed release: https://github.com/advisories/GHSA-378v-28hj-76wf
- uuid fixed release: https://github.com/advisories/GHSA-w5hq-g745-h8pq
- Remaining stream-json advisory: https://github.com/advisories/GHSA-528h-pc64-c93x

The last advisory explicitly excludes the StreamValues/StreamArray/StreamObject
streamers. Installed jayson uses StreamValues and Verifier, not the affected
path filters. npm still flags the dependency tree. This is an inspected usage
limitation, not a claim that arbitrary future use is safe. Forcing stream-json
3.x into jayson's 1.x CommonJS API is not an accepted fix; track upstream support.
