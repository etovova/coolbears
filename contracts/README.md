# CoolBears TON contracts

Production parameters:

- Network: TON mainnet (deployment only after testnet verification)
- Total supply: 10,000 NFTs
- Public mint price: 7 TON per NFT
- Maximum per transaction: 50
- Lifetime wallet limit: none
- Royalty: 7%
- Treasury / royalty recipient: `UQBuosyZXH1PI2RBxsUgsjbD6RnsVOMxtCaVKEKMZRpXF9m7`
- Reveal: 2026-10-07
- Pre-reveal image: `ipfs://bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni`
- Pre-reveal metadata: `ipfs://bafkreib7p7wx427quboakukbl6mebpksyjp4r5vurqif3p6bh3a7ssyzq4`
- Verified pre-reveal metadata root (10,000 items): `ipfs://bafybeihbfkbjdlnvtm4pchzdqktyskxpyuzwqqxymiqtolzftgbou2qj2e/`
- Collection metadata: `ipfs://bafkreibxu7idtw4s2zwvtvhjhdwxfeahizx3mkn6akqvxus37q2zgcc24e`

## Contract baseline

The collection implementation must remain compatible with TON NFT standards and marketplace discovery. The reference baseline is the official `ton-blockchain/token-contract` NFT implementation, including the editable collection contract for controlled metadata updates/reveal.

The mint layer must enforce on-chain rather than trusting the website:

1. exactly 7 TON sale price per minted NFT (plus explicitly handled network/deployment reserve);
2. total supply never above 10,000;
3. maximum 50 NFTs in one mint request;
4. no lifetime per-wallet cap;
5. sequential/unique item indexes;
6. treasury withdrawals restricted to the administrator;
7. no arbitrary public metadata/reveal mutation;
8. 7% royalty parameters returned by the collection;
9. failed/underpaid requests must not silently mint;
10. public mint can be paused before deployment/reveal operations.

## Pre-reveal privacy

Before reveal, public token metadata must expose only the hidden/pre-reveal image and the unrevealed status. Final artwork, final traits and rarity must not be published through the active metadata root. Reveal is performed by the owner changing the common metadata root, while preserving each NFT address, index and owner.

## Security rule

Never commit a seed phrase, private key, mnemonic, wallet backup, deployment key or Pinata JWT. Deployment signing must happen in the owner's wallet or an isolated deployment environment.

## Deployment gate

`config.js` intentionally keeps `collectionAddress` and `mintContractAddress` empty and `demoMode: true` until contracts have been compiled, tested on TON testnet, addresses verified, and the production transaction payload integrated with TON Connect. Do not switch the website to production mint before those checks pass.

## Founder reserve

No rare NFT is secretly assigned in this contract plan. If a Founder/Team Legendary is reserved, it must be explicitly configured and disclosed before deployment, with the public mint allocation adjusted accordingly.
