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
  preRevealMetadataCid: 'bafkreiawi23ti2ptlsg62ljsafxt6fzyv4pw55iaxvdm2vaktow253nx5i',
  preRevealMetadataRootCid: 'bafybeibx4t7s52qghnosicl3fd2t2pjdxs2oij5sez3mri3k5q5y7wdtsm',
  collectionMetadataCid: 'bafkreidhyuzo4lkhtsy2uipzfucvz6hiyeu5zo2zvxtficrlo7wzlyv3ui',
  preRevealImageIpfs: 'ipfs://bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni',
  preRevealMetadataIpfs: 'ipfs://bafkreiawi23ti2ptlsg62ljsafxt6fzyv4pw55iaxvdm2vaktow253nx5i',
  preRevealMetadataRootIpfs: 'ipfs://bafybeibx4t7s52qghnosicl3fd2t2pjdxs2oij5sez3mri3k5q5y7wdtsm/',
  collectionMetadataIpfs: 'ipfs://bafkreidhyuzo4lkhtsy2uipzfucvz6hiyeu5zo2zvxtficrlo7wzlyv3ui',
  collectionAddress: 'UQCaIEXpRw1EJzn6juFRXsywl9MWZ7QvlmkrA6_67ta2clK-',
  mintContractAddress: 'EQCaIEXpRw1EJzn6juFRXsywl9MWZ7QvlmkrA6_67ta2cg97',
  collectionCodeHash: '9fc5ea62b3c0ad943cec55deef509bdf9fabafa2cca0616f74f4fae46587f231',
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
    liveMint.src = 'mint-live.js?v=1';
    liveMint.defer = true;
    document.body.appendChild(liveMint);
  }
});
