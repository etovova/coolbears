# CoolBears release candidate — not deployed

This code is isolated from `contracts/src/` and from `mainnet/owner/deployment.json`. It is not a production release. Website signing remains held and `demoMode` remains true. No live-chain transaction is part of the test workflow.

Candidate behavior: 10,000 items; #0000 reserved for the immutable treasury; price 7 TON; minimum incoming amount 7.10 TON per item; 1–50 items per request. A spendable execution remainder is returned to the payer; NFT creation funding and network fees are separate. Surplus withdrawal is restricted to the immutable treasury and retains an operating balance. Royalty configuration and bytecode cannot be edited through this candidate.

Reveal: one-time installation of precommitted content, no earlier than 2027-01-01 00:00:00 UTC. The exact content cell must match the commitment. An external reveal message requires no wallet signing key; a paid internal reveal is also available. Early, wrong and repeated external messages are checked before ACCEPT. The test fixtures use dummy final URLs and must never become a mainnet deployment.

This is not a self-triggering clock. Automatic operation still needs a configured external scheduler and a securely held reveal payload, retry/verification, adequate contract balance and a tested manual fallback. No scheduler is enabled by this commit. Final content must remain private before reveal; do not commit its preimage, URLs, layer assignments or rankings into this public repository.

Before production: finalize/pin and verify all v3 assets and metadata privately; derive the real commitment and new contract address; reconcile all frontend parsing and release gates with the new data layout; verify the candidate on testnet; confirm the old address has not been deployed; complete independent review and a signed release approval. Deploy, creator claim and public opening require separate, explicit wallet actions. Do not transfer TON manually to the legacy address.

Run `node contracts/candidate/test.mjs` in the versioned offline test environment. GitHub Actions retains the actual test results and bytecode as evidence. Passing sandbox tests is not a guarantee of mainnet behavior or marketplace indexing.
