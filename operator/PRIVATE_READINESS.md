# Offline private setup inspection

`private-readiness.mjs` checks whether an existing encrypted deployment bundle
and existing prepared owner/buyer gateway files describe the same closed Devnet or Mainnet
setup. It uses the current Core and Core Candy Machine validators and canonical
plan compiler. It is an inspector, not a second deployment or custody system.

Provide exactly the three private directories you intend to inspect:

```sh
node operator/private-readiness.mjs inspect /absolute/private/bundle /absolute/private/owner-gateway /absolute/private/buyer-gateway
```

The bundle directory must be the existing output of
[`deployment/custody.mjs init`](deployment/CUSTODY.md), containing `vault.json`,
`READY.json` and `journal/`. The owner directory must contain the existing
`policy.json` and `entry.mjs` from
[`deployment/gateway/prepare.mjs`](deployment/gateway/README.md); the buyer
directory must contain the existing `config.json` and `entry.mjs` from
[`orders/gateway/prepare.mjs`](orders/gateway/README.md). This command does not
create missing inputs, search for private files, run either preparation command,
or import/execute either supplied entry module.

The command emits one JSON report. Exit code 0 and
`status: "offline-bindings-verified"` mean only that the supplied local artifacts
passed this inspection. Exit code 1 and `status: "blocked"` identify a concrete
missing, malformed, stale, mismatched or unavailable input. The programmatic
`inspectPrivateReadiness({ bundleDirectory, ownerGatewayDirectory,
buyerGatewayDirectory, trustedHiddenCommitmentSha256 })` API returns the same
report; omitted paths produce separate `*_PATH_REQUIRED` checks. The optional
digest has the stricter Mainnet hidden-profile requirement below. All other
extra fields, including caller-supplied "passed" booleans, are rejected.

For a Mainnet `hidden-settings` bundle, supply the independently approved
commitment explicitly through `trustedHiddenCommitmentSha256`, or through
`COOLBEARS_HIDDEN_COMMITMENT_SHA256` in the CLI environment. The CLI command and
its three directory arguments remain exactly as shown above; this offline
inspector does not take `--mainnet`, a send flag or a signing flag. It selects
the network only from the existing validated bundle's `manifest.cluster`.
Environment variables naming another cluster cannot switch that bundle.

The external commitment must be exactly 64 lowercase hexadecimal characters,
nonzero and equal to the bundle's declared hidden commitment. The inspector
does not infer the expected value from the package being inspected. A missing
or different value blocks the bundle check with
`BUNDLE_TRUSTED_HIDDEN_COMMITMENT_REQUIRED`; a malformed supplied argument
produces `ARGUMENTS_INVALID`. This requirement does not apply to Mainnet
config-lines bundles. Existing Devnet inputs remain compatible without a
supplied digest.

The inspector performs these checks:

- The existing `readDeploymentBundle` verifies the private encrypted envelope,
  readiness hashes, canonical SDK manifest and full journal replay. The
  inspector also bounds the bundle inventory and rejects pending files or an
  existing writer lock, retaining them untouched.
- The owner policy must equal a fresh offline compilation from that manifest
  and all currently retained signed journal attempts. Missing or unrelated
  recovery signatures and foreign message/account policy produce
  `OWNER_POLICY_STALE_OR_MISMATCHED`. `allowSimulation` remains a configuration
  setting; its value is never accepted as evidence that a simulation happened.
- The buyer config passes the existing strict validator, and its machine,
  collection, guard and cluster must match the same canonical deployment.
  A Mainnet buyer config must also pin the full genesis hash from the shared
  immutable network profile. Its HTTPS
  origin is syntactically validated; ownership and live routing are unverified.
- Supplied entry modules must equal the recognized generated sources. The owner
  entry with `allowSubmission: true` or `allowMainnetSubmission: true` produces
  `OWNER_SUBMISSION_ENABLED`. Mainnet owner entries explicitly set
  `allowSubmission: false`, `allowMainnet: true` and
  `allowMainnetSubmission: false`; Mainnet buyer entries set `allowMainnet: true`
  and retain the default disabled sender. Both Mainnet hidden entries must
  contain the exact externally supplied trusted digest. Historical Devnet
  owner entries and the newly generated three-false-flag form both remain
  accepted. Entry text is never executed to infer safety; additional signing
  or send code is rejected.
- Before releasing a successful report, the inspector re-reads the bundle and
  all four config/entry files. A different manifest, journal head/revision,
  encrypted envelope, file bytes or unavailable input blocks the result.

The successful `binding` includes manifest/head/revision, hashes of the two
config files and two inert entries, and a hash of that inspection binding.
For Mainnet it also includes the shared full `genesisHash`. The Devnet binding
shape is unchanged. Hidden bindings retain `privateMappingVerified: false`:
matching a commitment does not verify the private mapping, image bytes or
availability of final artwork.
It emits no local path, account address, reserved asset identifier, vault field,
passphrase, credential or transaction bytes. Errors use fixed codes and never
include raw exception messages or input values. Config files must be owned
regular mode-0600 files in real mode-0700 directories; symlinks, special files,
unsafe modes and invalid UTF-8/JSON are rejected. Limits are 16 MiB for the
manifest, 2 MiB for owner policy, 16 KiB for other config/entry/envelope files,
64 KiB per journal event, 20,000 events and 64 MiB for the total bundle inventory.

`prerequisites` always reports the following as unverified: deployment-key
unlock, live owner/buyer endpoints, secret installation, live RPC path and
unsigned simulation, real wallets/phones, and deployment/on-chain
reconciliation. The inspector never requests a passphrase or unlocks a key.
The CLI reads only the declared commitment environment variable for this
inspection, not credentials or custody secrets. It never invokes a wallet, creates a key, signs,
sends, performs RPC, deploys, changes permissions, cleans up, or writes an input
file. `deploymentPerformed: false` describes this command's actions; it does
not assert whether a deployment already exists on chain. Sales and readiness
flags remain false. This report is not a funding quote or permission to launch.

The observed journal head binds this inspection. Existing preparation files do
not record their original generation head, so this tool cannot prove that
historical head. A policy whose meaning still matches the current journal may
pass even if it was generated earlier. As with the existing bundle reader,
restoring a valid journal prefix cannot be detected without an independently
retained checkpoint. A successful report is an observation of the bytes read,
not a lock or an authorization for later actions; changed inputs need a new
inspection. No claim is made that local normalized journal proofs independently
authenticate chain state.

`tests/private-readiness.test.mjs` creates disposable synthetic Devnet and
Mainnet bundles using the existing custody APIs to test matching files, missing input,
malformed/secret-bearing config, caller booleans, mismatched roles, enabled
sender, unsafe files, pending state, stale retained-signature policy and safe
CLI output. Mainnet coverage checks the external commitment, full genesis,
crossed network profiles and noncanonical or send-enabled entry sources;
Devnet coverage preserves its report shape. File bytes are compared before/after inspection and network access
is disabled. These tests establish offline behavior only.
