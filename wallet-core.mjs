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

// This controller requests only a public address. Signing is a separate action.
export function createWalletSession(onChange = () => {}) {
  let provider = null;
  let address = '';
  let listeners = [];
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
      const result = await nextProvider.connect();
      const key = result?.publicKey || nextProvider.publicKey;
      if (!key) throw new Error('Wallet did not return an address');
      detach();
      provider = nextProvider;
      const watchedProvider = provider;
      listeners = [
        ['accountChanged', key => { if (provider === watchedProvider) setAddress(key); }],
        ['disconnect', () => { if (provider === watchedProvider) { detach(); provider = null; setAddress(null); } }]
      ];
      for (const [event, handler] of listeners) provider.on?.(event, handler);
      setAddress(key);
      return address;
    },
    async disconnect() {
      if (!provider) { setAddress(null); return; }
      await provider.disconnect();
      detach();
      provider = null;
      setAddress(null);
    }
  };
}
