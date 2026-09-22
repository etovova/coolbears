export function detectWallets(scope = globalThis) {
  const wallets = [];
  const phantom = scope.phantom?.solana;
  if (phantom?.isPhantom) wallets.push({ name: 'Phantom', provider: phantom });
  if (scope.solflare?.isSolflare) wallets.push({ name: 'Solflare', provider: scope.solflare });
  return wallets;
}

export function phantomBrowseUrl(url) {
  const page = new URL(url);
  if (page.protocol !== 'https:') throw new Error('HTTPS required');
  page.hash = '';
  return `https://phantom.app/ul/browse/${encodeURIComponent(page.href)}?ref=${encodeURIComponent(page.origin)}`;
}

export function solflareBrowseUrl(url) {
  const page = new URL(url);
  if (page.protocol !== 'https:') throw new Error('HTTPS required');
  page.hash = '';
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(page.href)}?ref=${encodeURIComponent(page.origin)}`;
}

// Keep common wallets visible and append compatible registered wallets.
export function getWalletOptions(scope, pageUrl, mobile, standard = []) {
  const detected = [...detectWallets(scope), ...standard];
  const options = [
    { name: 'Phantom', browse: phantomBrowseUrl, install: 'https://phantom.com/download' },
    { name: 'Solflare', browse: solflareBrowseUrl, install: 'https://www.solflare.com/download/' },
    { name: 'Backpack', install: 'https://backpack.app/' }
  ].map(wallet => {
    const available = detected.find(item => item.name === wallet.name);
    return available || { name: wallet.name, href: mobile && wallet.browse ? wallet.browse(pageUrl) : wallet.install, opensApp: Boolean(mobile && wallet.browse) };
  });
  for (const wallet of detected) if (!options.some(item => item.name.toLowerCase() === wallet.name.toLowerCase())) options.push(wallet);
  return options;
}

// This controller requests only a public address. Signing is a separate action.
export async function walletDeadline(promise, timeoutMs = 60000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Wallet did not respond. Please try again.'), { code: 'WALLET_TIMEOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function createWalletSession(onChange = () => {}, { timeoutMs = 60000 } = {}) {
  let provider = null;
  let address = '';
  let listeners = [];
  let attempt = 0;
  const setAddress = key => { address = key?.toString() || ''; onChange(address); };
  function detach() {
    for (const [event, handler] of listeners) provider?.removeListener?.(event, handler);
    listeners = [];
  }
  return {
    get address() { return address; },
    get provider() { return provider; },
    async connect(nextProvider) {
      if (!nextProvider?.connect) throw new Error('Solana wallet unavailable');
      const currentAttempt = ++attempt;
      const result = await walletDeadline(Promise.resolve().then(() => nextProvider.connect()), timeoutMs);
      if (currentAttempt !== attempt) throw new DOMException('Wallet connection was replaced', 'AbortError');
      const key = result?.publicKey || nextProvider.publicKey;
      if (!key) throw new Error('Wallet did not return an address');
      detach();
      provider = nextProvider;
      const watchedProvider = provider;
      listeners = [
        ['connect', key => { if (provider === watchedProvider) setAddress(key); }],
        ['accountChanged', key => { if (provider === watchedProvider) setAddress(key); }],
        ['disconnect', () => { if (provider === watchedProvider) { detach(); provider = null; setAddress(null); } }]
      ];
      for (const [event, handler] of listeners) provider.on?.(event, handler);
      setAddress(key);
      return address;
    },
    async disconnect() {
      const currentAttempt = ++attempt;
      if (!provider) { setAddress(null); return; }
      const selectedProvider = provider;
      await walletDeadline(Promise.resolve().then(() => selectedProvider.disconnect()), timeoutMs);
      // A late response from an older provider must not clear a new connection.
      if (currentAttempt !== attempt || provider !== selectedProvider) return;
      detach();
      provider = null;
      setAddress(null);
    }
  };
}
