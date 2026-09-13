# CoolBears contract source status

`coolbears-collection-mint.fc` is the first implementation draft of the public mint path.

It intentionally remains deployment-blocked. Before testnet it must:

- compile with the TON toolchain;
- be integrated with the pinned official NFT item code;
- preserve collection discovery/get-method compatibility;
- pass TON sandbox tests for 1, 50, underpaid, paused, sold-out and repeated-wallet mint cases;
- measure the actual NFT deploy/forward/storage reserve instead of trusting the provisional 0.05 TON constant;
- verify treasury forwarding and failure behavior;
- verify owner-only reveal/content mutation;
- verify 7% royalty response;
- verify metadata paths for all indexes 0..9999;
- undergo testnet mint/transfer/reveal checks with common TON wallets and marketplace indexing.

The public website must continue to show `7 GRAM (TON)` while the underlying settlement remains 7 TON per NFT. Any extra network/deployment reserve must be shown separately and must not be described as NFT price.

Do not put a mnemonic, seed phrase or private key in this repository.
