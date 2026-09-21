export const SPEC = Object.freeze({
  schema: 'coolbears-core-v2', owner: 'FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y',
  supply: 10000, publicSupply: 9999, priceLamports: 500000000n, royaltyBps: 700,
  maxPerOrder: 50, revealNotBefore: 1798761600,
  collectionUri: 'https://coolbears-nfts.com/metadata/collection.json',
  hiddenUri: 'https://coolbears-nfts.com/metadata/mint/$ID+1$.json',
  hiddenName: 'CoolBears #$ID+1$ — Hidden Bear',
  reservedUri: 'https://coolbears-nfts.com/metadata/hidden/0000.json',
});
export const CLOSED_DATE = 9223372036854775807n;
export const GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
export const PROGRAMS = Object.freeze({
  core: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  machine: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  guard: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
});
export function assertQuantity(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > SPEC.maxPerOrder) throw Error('Quantity must be 1–50');
  return n;
}
export function validateCommitment(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash) || /^0+$/.test(hash)) throw Error('A verified SHA-256 reveal commitment is required');
  return Uint8Array.from(hash.match(/../g), h => parseInt(h, 16));
}
export function revealBytes(map) {
  if (!Array.isArray(map) || map.length !== SPEC.supply) throw Error('Reveal must contain exactly 10000 entries');
  const uris = new Set();
  const normalized = map.map((item, index) => {
    if (item.index !== index || item.name !== `CoolBears #${String(index).padStart(4, '0')}`) throw Error('Reveal ordering/name mismatch');
    if (typeof item.uri !== 'string' || !/^(ipfs:\/\/|https:\/\/)/.test(item.uri) || new TextEncoder().encode(item.uri).length > 200 || uris.has(item.uri)) throw Error('Invalid or duplicate reveal URI');
    uris.add(item.uri);
    return { index, name: item.name, uri: item.uri };
  });
  return new TextEncoder().encode(JSON.stringify(normalized));
}
export async function commitmentFor(map) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', revealBytes(map))), b => b.toString(16).padStart(2, '0')).join('');
}
export function indexFromName(name) {
  const match = /^CoolBears #(\d{1,4})(?: — Hidden Bear)?$/.exec(name);
  if (!match || Number(match[1]) >= SPEC.supply) throw Error('Unknown CoolBears asset name');
  return Number(match[1]);
}
export function assertRevealTime(chainTime) {
  if (!Number.isSafeInteger(chainTime) || chainTime < SPEC.revealNotBefore) throw Error('Reveal is available no earlier than January 1, 2027');
}
