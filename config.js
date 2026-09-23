window.COOLBEARS_CONFIG = {
  officialWebsite: 'https://coolbears-nfts.com',
  network: 'solana',
  cluster: 'devnet',
  priceSol: 0.2,
  supply: 10000,
  royaltyPercent: 7,
  maxPerOrder: 50,
  revealDate: '2027-01-01',
  ownerAddress: 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y',
  collectionAddress: '',
  candyMachineAddress: '',
  treasuryAddress: '',
  royaltyAddress: '',
  magicEdenUrl: '',
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
