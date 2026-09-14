window.COOLBEARS_CONFIG = {
  officialWebsite: 'https://coolbears-nfts.com',
  network: 'mainnet',
  priceTon: 7,
  supply: 10000,
  royaltyPercent: 7,
  maxPerTransaction: 50,
  revealDate: '2026-10-07',
  preRevealImageCid: 'bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni',
  preRevealMetadataCid: 'bafkreib7p7wx427quboakukbl6mebpksyjp4r5vurqif3p6bh3a7ssyzq4',
  preRevealMetadataRootCid: 'bafybeihbfkbjdlnvtm4pchzdqktyskxpyuzwqqxymiqtolzftgbou2qj2e',
  collectionMetadataCid: 'bafkreibxu7idtw4s2zwvtvhjhdwxfeahizx3mkn6akqvxus37q2zgcc24e',
  preRevealImageIpfs: 'ipfs://bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni',
  preRevealMetadataIpfs: 'ipfs://bafkreib7p7wx427quboakukbl6mebpksyjp4r5vurqif3p6bh3a7ssyzq4',
  preRevealMetadataRootIpfs: 'ipfs://bafybeihbfkbjdlnvtm4pchzdqktyskxpyuzwqqxymiqtolzftgbou2qj2e/',
  collectionMetadataIpfs: 'ipfs://bafkreibxu7idtw4s2zwvtvhjhdwxfeahizx3mkn6akqvxus37q2zgcc24e',
  collectionAddress: '',
  mintContractAddress: '',
  treasuryAddress: 'UQBuosyZXH1PI2RBxsUgsjbD6RnsVOMxtCaVKEKMZRpXF9m7',
  royaltyAddress: 'UQBuosyZXH1PI2RBxsUgsjbD6RnsVOMxtCaVKEKMZRpXF9m7',
  getgemsUrl: '',
  demoMode: true
};

// Keep section navigation, but keep the browser address clean.
document.addEventListener('DOMContentLoaded', () => {
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const hash = link.getAttribute('href');
    if (!hash || hash === '#') return;
    const target = document.querySelector(hash);
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', location.pathname + location.search);
  });
});
