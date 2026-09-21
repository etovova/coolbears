# CoolBears — official SDK release

Isolated rebuild, not deployed to the public website.

Install: `npm ci --prefix release --ignore-scripts`.
Verify official instruction construction: `npm run --prefix release verify:settings`.

The checked source decisions are in SOURCES.md. The settings report explicitly covers offline SDK construction only. Real Devnet execution, the physical Phantom wallet, and marketplace indexing are separate gates.

Private artwork and test keypairs stay in the root private/ directory. Never commit them. No owner seed or private key is required.
