# Offline private setup inspection

`private-readiness.mjs` checks whether an existing encrypted deployment bundle
and existing prepared owner/buyer gateway files describe the same closed Devnet
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
buyerGatewayDirectory })` API returns the same report; omitted paths produce
separate `*_PATH_REQUIRED` checks. Extra fields, including caller-supplied
"passed" booleans, are rejected.

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
  collection and guard must match the same canonical deployment. Its HTTPS
  origin is syntactically validated; ownership and live routing are unverified.
- Supplied entry modules must equal the recognized generated sources. The owner
  entry with `allowSubmission: true` produces `OWNER_SUBMISSION_ENABLED`. The
  buyer entry must retain the default disabled sender. Entry text is never
  executed to infer safety.
- Before releasing a successful report, the inspector re-reads the bundle and
  all four config/entry files. A different manifest, journal head/revision,
  encrypted envelope, file bytes or unavailable input blocks the result.

The successful `binding` includes manifest/head/revision, hashes of the two
config files and two inert entries, and a hash of that inspection binding.
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
It never reads environment secrets, invokes a wallet, creates a key, signs,
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

`tests/private-readiness.test.mjs` creates one disposable synthetic bundle using
the existing custody APIs, then reuses it to test matching files, missing input,
malformed/secret-bearing config, caller booleans, mismatched roles, enabled
sender, unsafe files, pending state, stale retained-signature policy and safe
CLI output. File bytes are compared before/after inspection and network access
is disabled. These tests establish offline behavior only.
