# CoolBears shared Devnet RPC

This Worker is a narrow proxy for the existing **two-item, owner-only Devnet laboratory**. It does not open sales, mint by itself, change the collection or support Mainnet. The browser keeps signing in the wallet and verifying finalized ownership afterward.

## Interface and deployment configuration

- `POST /rpc`, one JSON-RPC request. `OPTIONS /rpc` supports the site's browser preflight, including web3.js's `solana-client` header.
- Exact browser origin: `https://coolbears-nfts.com`; query strings, other routes, batch requests, WebSockets and other methods are rejected.
- Upstream is compiled as `https://devnet.helius-rpc.com/`. Only `HELIUS_API_KEY`, installed as a **Worker secret**, supplies its key. No caller URL or caller authorization/cookie headers reach upstream.
- All Worker instances use `RPC_GATE.idFromName('coolbears-devnet-v1')`, one SQLite-backed Durable Object, including after restarts and deployments.
- `DAILY_CREDIT_CAP` defaults to `20000`; deployment configuration can lower it to `1..20000`. A malformed setting or absent secret fails closed. It counts every admitted upstream attempt, including failures, conservatively at one credit per allowed standard RPC call.

The committed `wrangler.jsonc` contains no key or account identity. Install the secret using `wrangler secret put HELIUS_API_KEY --config rpc-proxy/wrangler.jsonc`, then follow the deployment and read-only verification procedure in [operator/SHARED_RPC.md](../operator/SHARED_RPC.md). Do not put the key in a frontend bundle, GitHub Pages file, public repository, command argument, example URL or request log. This implementation disables application observability logs and never prints provider errors. The provider necessarily receives its own key over TLS.

Only the dedicated Worker URL ending in `/rpc` belongs in the website configuration. Deploying this code and configuring a usable URL are separate steps; the source files alone do not create a working service.

## Admission and costs

Admission is immediate: one start per **130 ms** across reads and writes (less than eight requests/second), and additionally one send per **1100 ms**. Requests that cannot start now receive `429` and an exposed `Retry-After`; there is no long transaction queue. Upstream `429`/`503` cooldowns are persisted globally. The Worker makes **one upstream attempt**, with no fallback or retry.

A synchronous guard immediately before `fetch` also enforces actual dispatch spacing if durable commits resume late. A restored object pauses new admission until 1100 ms after construction, closing the gap left by the previous instance's last delayed dispatch; a genuinely new empty ledger needs no pause. Known duplicate outcomes remain available during this brief warmup. A rare refusal after a send claim has already committed retains that claim as unknown and requires normal read-only recovery; it never starts a queued or automatic send.

One storage transaction atomically reserves the rate slot, credit budget, per-IP budget and send claim. No network request occurs inside that transaction. Default limits are 20000 global attempts/day, 1000 per client IP/day, 1000 global simulations/day and 200 simulations/IP/day, resetting by UTC day. IPs are salted and hashed for counters; missing IPs share one bucket. The same shared quota applies to all visitors and persists after eviction. Native storage and platform errors fail closed.

**CORS is not authentication.** Non-browser clients can forge `Origin`. Validation, the fixed transaction scope, global and per-IP caps limit usage but cannot promise availability against abuse. Cloudflare's own free request/CPU/storage limits can still be exhausted. Consider account-side WAF/rate controls when enabling a public endpoint. A daily cap protects only calls through this one object; other applications using the same Helius key, operator tests and provider billing changes are outside its accounting. Do not enable automatic paid credit expansion to compensate for abuse without an explicit budget decision.

Per-IP counters are small persistent records, and send claims retain only signature, SHA-256, state and creation time, never signed transaction bytes. They are intentionally not automatically deleted. Monitor storage; do not reset the object name or restore old storage while any transaction might still be live, because that would erase deduplication evidence. Archived expired claims can only be removed through a separately reviewed maintenance procedure.

## Allowed scope and transaction behavior

The method list is in `policy.mjs`. `getMultipleAccounts` is restricted to the exact lab machine/guard/collection triple; `getBalance` to the owner; history/status/account queries have small fixed caps. DAS, account scans, airdrops, subscriptions and arbitrary RPC calls are rejected.

Simulation and sending accept only the exact current Core mint template: canonical v0, two signers, no address lookups, the fixed owner/machine/guard/collection and machine authority, one compute-budget instruction for 300000 units and one Core Candy Guard mint instruction. Instruction bytes, key order, writable/signer header and account indices must match. Simulations require the owner signature to be empty and the asset signature valid; sends require both signatures to verify cryptographically. This deliberately fails closed if a future SDK changes the transaction layout; update the policy and its tests before using another machine or format.

Send options are fixed to `encoding: base64`, `preflightCommitment: confirmed`, `skipPreflight: false`, `maxRetries: 5`. `maxRetries` controls forwarding of the same signed transaction inside Solana RPC; the Worker itself sends one HTTP request.

Before that request, a durable signature/hash claim is committed. A duplicate with a known accepted response returns that same signature without contacting upstream. An unknown earlier attempt returns `409`; it never resends after a timeout, network failure or object restart. An accepted signature is **not finalization or NFT ownership proof**. The browser must recover the same saved operation with read-only checks. A crash between committing the claim and making the network request can leave a transaction unsubmitted; this availability tradeoff prevents an uncertain attempt from silently being submitted again.

## Bounds and privacy

Request streams are limited to 8192 bytes and four seconds; upstream fetch plus response streaming is limited to 131072 bytes and twelve seconds. Requests use `redirect: manual` and reject every non-success response, including redirects, without following another URL. Oversized, truncated, malformed and invalid responses fail closed. No upstream error text/data, simulation logs, transaction memos or arbitrary extension fields are returned; responses are projected onto the exact fields consumed by the site. RPC errors include only fixed categories and an allowlisted numeric code. The Devnet genesis response must match the expected genesis.

The exported class accepts trusted constructor overrides for offline tests (`fetchImpl`, `now`, `limits`, `lab`). Those values have no HTTP/environment configuration path. Test keys can therefore exercise real signatures without obtaining the owner's key or sending a real transaction.

## Primary references

- [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction): acceptance is not confirmation; the first signature identifies the transaction.
- [Helius credits](https://www.helius.dev/docs/billing/credits): allowed standard RPC methods currently cost one credit; the documentation must be rechecked before changing budgets or methods.
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): Workers Free supports SQLite-backed objects and has separate platform limits.
- [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): transactional storage and durability across instances.
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/): secret configuration outside public source.
