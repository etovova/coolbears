window.COOLBEARS_CONFIG = {
  officialWebsite: 'https://coolbears-nfts.com',
  network: 'mainnet',
  priceTon: 7,
  mintPaymentPerNftTon: 7.10,
  mintPaymentPerNftNano: 7100000000,
  supply: 10000,
  royaltyPercent: 7,
  maxPerTransaction: 50,
  revealDate: '2027-01-01',
  preRevealImageCid: 'bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni',
  preRevealMetadataCid: 'bafkreiets6dggsposhh3wrejv6cycp4cts37bdnslrpg5vk5oivziirzxy',
  preRevealMetadataRootCid: 'bafybeiegnm5qswti42bgpdbj6omhn2ms4pju56oowok5st3pqqiuspzcgq',
  collectionMetadataCid: 'bafkreie4sz5onduteuzkddtg7vqf2fyntwxhlwuy3hlf366i6en6qrti7u',
  preRevealImageIpfs: 'ipfs://bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni',
  preRevealMetadataIpfs: 'ipfs://bafkreiets6dggsposhh3wrejv6cycp4cts37bdnslrpg5vk5oivziirzxy',
  preRevealMetadataRootIpfs: 'ipfs://bafybeiegnm5qswti42bgpdbj6omhn2ms4pju56oowok5st3pqqiuspzcgq/',
  collectionMetadataIpfs: 'ipfs://bafkreie4sz5onduteuzkddtg7vqf2fyntwxhlwuy3hlf366i6en6qrti7u',
  collectionAddress: 'UQDXQnCTPsnb2fI8_CEL3TC-gKsTK_bbwPkSOPoerkcAeclm',
  mintContractAddress: 'EQDXQnCTPsnb2fI8_CEL3TC-gKsTK_bbwPkSOPoerkcAeZSj',
  collectionCodeHash: '4a5dcc56c96ab4bfb1815242b3e696ee1a1663c9f1254c893455d47bb746dc2b',
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

  // Production mint code is shipped but remains inert until mainnet is verified
  // and demoMode is deliberately switched off by the release gate.
  if (!window.COOLBEARS_CONFIG.demoMode && window.COOLBEARS_CONFIG.mintContractAddress) {
    const liveMint = document.createElement('script');
    liveMint.src = 'mint-live.js?v=release-guard-1';
    liveMint.defer = true;
    document.body.appendChild(liveMint);
  }
});
