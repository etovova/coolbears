# Private Devnet operator gateway

This is a separate candidate for the full closed deployment. It does not modify
`coolbears-devnet-rpc`, its ledger, browser CORS, secrets, routes or Helius plan.
Nothing here deploys a Worker, creates blockchain accounts, signs or sends a transaction.

The server independently enforces the same compiled policy as the PR30 client:
seven exact accounts, one payer, known rent sizes and all 1431 canonical message
identities. Only the recent blockhash is normalized. Simulations require a
compile-time opt-in, exact transaction bytes and valid nonempty signatures.
Recovery signatures are fixed from the existing private journal. They must be
recompiled when that journal gains a new signed attempt. Runtime policy inputs,
registration routes, scans, batch, airdrop and send methods are absent.

## Private configuration

Prepare the existing canonical Devnet journal, with the actual account addresses
and custody bundle, before generating the deployable entry. Fixture addresses
must not be used. In the private operator environment:

```sh
node operator/deployment/gateway/prepare.mjs /absolute/private/journal --allow-simulation
```

Omit `--allow-simulation` for read-only configuration. The command validates the
full SDK plan and checks the journal did not change. It creates a new mode-0700
`gateway/private/` directory with mode-0600 files; existing output is never
silently overwritten. That directory is ignored by Git. The generated policy
is trusted deployment configuration, not a client-supplied authorization claim.
No actual policy or credentials are included in this repository.

`wrangler.jsonc` names **coolbears-deployment-rpc**, with its own SQLite Durable
Object namespace. Its entry is deliberately absent until private preparation.
Store `OPERATOR_RPC_TOKEN` (a random 32-byte base64url secret, at least 43 chars)
and the selected `HELIUS_API_KEY` as this Worker's secrets. Never put either in
Git, frontend code, screenshots, reports or CLI command arguments. Key rotation
keeps the same Durable Object identity and does not reset its counters.

Use `COOLBEARS_RPC_URL=https://<chosen-private-endpoint>/rpc` and
`COOLBEARS_OPERATOR_RPC_TOKEN` only in the private operator process.
`deployment/check.mjs` then adds Bearer authorization and serializes its existing
parallel callers. It pins the exact URL, forbids redirects, rejects queued
requests whose deadline has expired and never retries 429 or any transaction.
Without the token variable, the existing direct private endpoint mode remains
available. Invalid or empty token configuration fails closed.

Before publishing, review the concrete generated configuration and install the
secrets through the account's secure flow. Neither this README nor a successful
local test confirms endpoint installation. A live authenticated read and exact
unsigned simulation remain separate checks after real configuration exists.

## Bounds and persistence

- HTTPS POST `/rpc`, numeric JSON-RPC id, 8 KiB streamed request cap / 4 s deadline.
- Constant-length digest comparison of the bearer credential. Origin/cookie
  requests are rejected and no browser CORS authorization is issued.
- Fixed Devnet Helius upstream and server-side genesis verification after each
  object recreation. Caller headers and bearer token never reach Helius.
- One operation in flight, at least 200 ms between upstream calls. A concurrent
  direct caller receives `BUSY`; the supplied operator adapter serializes calls.
- Default UTC budget: 5000 upstream attempts and 2000 simulations/day. Bounded
  configuration can lower these or raise them to at most 20000/5000. The count
  is an application allowance for the permitted standard RPC methods, not a
  substitute for the provider's billing dashboard or an account-wide quota.
- Every attempt, including genesis and failed HTTP calls, is charged durably
  before fetch. A crash retains a 15 s hold. Daily counters survive restarts,
  token rotation and clock rollback; corrupt/unavailable storage fails closed.
- 429/503 Retry-After is bounded to 1–300 s (5 s if absent/invalid) and persists.
  There is no hidden retry, endpoint fallback or refund of uncertain attempts.
- 4 MiB streamed response cap / 12 s deadline; provider errors are redacted.
  `manual` upstream redirect mode is necessary in the tested workerd runtime;
  the shared transport rejects every 3xx and never follows Location.

A separate key/Worker does not automatically isolate rate or credit allowances
at the Helius account level. Its configured quota must be considered alongside
other clients. No paid plan or account limit has been changed.

## Full budget integration

The estimate still requests all 1431 message fees. It now uses windows of at most
100 messages, refreshes the blockhash between windows and validates each window's
blockhash and height. Every fee context is checked. The overall deadline is
10 minutes; the last window is rechecked after the balance read. This is a bounded
estimate across multiple moments, not a single-bank snapshot, a funding
recommendation or a queue of transactions ready to sign. Fresh per-step preflight
and simulation remain mandatory. Each window and total elapsed time are recorded.

## Verification

```sh
node --test operator/tests/deployment-gateway.test.mjs
node --test operator/tests/deployment-budget-simulation.test.mjs
node operator/tests/deployment-gateway.runtime.mjs
```

The workerd test bundles a disposable fixture, intercepts every outbound HTTP
request, and exercises actual SQLite persistence across runtime restarts. The
full budget integration uses virtual time and rotates all 15 window hashes.
Neither test uses live Devnet, owner signatures or a deployed Cloudflare endpoint.
A separate CI job installs the pinned root and operator dependencies for workerd.

Primary references: [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Worker Request](https://developers.cloudflare.com/workers/runtime-apis/request/),
[Solana message fees](https://solana.com/docs/rpc/http/getfeeformessage).
