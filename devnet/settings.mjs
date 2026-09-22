// This is the existing two-item Devnet laboratory, not the production collection.
export const rpcPolicy = Object.freeze({
  totalTimeoutMs: 45000,
  attemptTimeoutMs: 25000,
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxPending: 8,
  minIntervalMs: 250,
});
export const settings = Object.freeze({
  rpc: 'https://api.devnet.solana.com',
  // Public site-managed relay only: https://<public-host>/rpc, never an API key.
  // Leave blank until that relay has been deployed and checked against Devnet.
  siteRpc: '',
  genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  owner: 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y',
  collection: 'FzzvNApx9E2Z6mvnu1DhHDsE1B1Q8kHQ8w4ZU4tQ8QmH',
  machine: 'CZsECgYevYf68MbjfeX11PrkbQnXdzrskWMAcWWgvyq2',
  guard: '7UHKjfr3tcJhiuiPXrzgX2nLE89LvTgmNW5zKnEawANo',
  laboratory: 'BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF',
  price: 500000000n,
  storageKey: 'coolbears:devnet:CZsECgYevYf68MbjfeX11PrkbQnXdzrskWMAcWWgvyq2:mint:v1',
});
