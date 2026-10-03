# Offline Mainnet support

The deployment journal, private owner console, scoped gateways and buyer
adapters support an explicitly selected `mainnet-beta` profile in addition to
the retained Devnet profile. This is source support, not an activated launch.
The public site, hosting, existing Devnet laboratory and real private setup are
separate. Sales remain closed at 0.2 SOL; readiness flags remain false.

## Network and permissions

`deployment/network.mjs` is the shared, immutable source of the full genesis
hash, Wallet Standard chain and gateway upstream for each supported cluster.
The selected cluster comes from a validated journal, order or static gateway
configuration. Request bodies and credentials cannot select another network.
Gateways use the profile's fixed Helius upstream; private CLI callers may supply
an explicit HTTPS endpoint, which must answer with that profile's full genesis.
There is no network fallback.

| Operation | Mainnet permission | CLI equivalent |
| --- | --- | --- |
| Scoped reads, simulation, recovery and resume | `authorizeMainnet: true` | `--mainnet` |
| Owner wallet signing | `authorizeMainnetSigning: true` | owner console `--mainnet-sign` |
| Deployment submission | `authorizeMainnetSend: true` | sender `--mainnet-send` |
| Gateway reads | `allowMainnet: true` | gateway preparation `--mainnet` |
| Gateway submission | `allowMainnetSubmission: true` | owner gateway preparation `--mainnet-send` |
| Private buyer console build | explicit factory `authorizeMainnet: true` | buyer console build `--mainnet` with validated `--config` |

Signing and sending are distinct capabilities. A Devnet send flag cannot permit
Mainnet submission; conflicting flags fail before claiming or sending an
attempt. Mainnet resume also needs explicit read consent and does not resend.
Devnet retains its existing default reads, journal format and send permission.
See [sending](deployment/SENDING.md) and
[the owner console](deployment/owner-console/README.md) for exact command syntax.

For Mainnet hidden-settings, the caller must provide an independently retained
`trustedHiddenCommitmentSha256` matching the canonical plan. Deployment and
inspector CLI tools use the owner-local `COOLBEARS_HIDDEN_COMMITMENT_SHA256`.
The buyer checker and gateway preparation retain their explicit local
`--storage-profile` input. A hash copied from a request,
saved manifest or provider response is not an independent trust anchor. No real
commitment, final CID, private inventory or key is supplied in this repository.

## Retained state

Mainnet durable gateway records use a separate version-2 namespace bound to the
cluster and full genesis hash. Devnet version-1 namespaces, claims, counters and
replay remain in place. Records cannot cross networks. Groups cannot mix
clusters. Portable Mainnet reports and browser scopes retain and validate the
network identity; an expected static genesis label does not imply that a live
network was checked.

Existing unknown outcomes still require recovery. Network support does not
clear history, release a claim, authorize a replacement, create a new deployment
or repeat the completed Devnet mint. Owner custody remains local; no password or
private key belongs in chat. The [offline inspector](PRIVATE_READINESS.md)
checks existing closed artifacts without unlocking keys or contacting RPC.

## Validation boundary

The Node tests use disposable synthetic keys and intercepted provider replies.
The workerd/SQLite checks exercise the actual bundled gateway and durable
storage locally. Browser checks use synthetic wallets and local fixtures. These
checks can establish serialization, capability gates, storage and recovery
behavior; they do not establish live Mainnet execution, real wallet or physical
phone compatibility, funding, endpoint deployment or marketplace acceptance.

The earlier `prepare.mjs`, `preflight.mjs`, `cost.mjs`, `simulate.mjs`,
`cli-transport.mjs`, deployment preview and isolated laboratory snapshot remain Devnet-only
milestones. Mainnet support belongs to the scoped journal and adapters above.
Preparing hidden metadata alone also leaves `readyToDeploy: false`.

Before an actual launch, a real network choice, owner-local encrypted custody,
closed private gateway setup, fresh read/simulation and budget, owner signing
and separately authorized submission still need concrete review. This source
change does not perform those steps, open sales or stage reveal.
