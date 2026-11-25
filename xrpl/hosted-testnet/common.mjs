export const ORIGIN = 'https://testnet.coolbears-nfts.com';
export const ISSUER = 'rEoKftiFRwknRDkbV2zURNc6KmhJoBxtaC';
export const METADATA = 'https://coolbears-nfts.com';
export const PRICE = '10000000';
export const ID = /^[A-F0-9]{64}$/;
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
export const bytes = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
export const utf8 = value => new TextEncoder().encode(value);
export const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
export function assert(value, message = 'Unexpected validated ledger data') {
  if (!value) throw Error(message);
}
