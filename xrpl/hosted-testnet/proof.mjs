import {deriveAddress, verify} from 'ripple-keypairs';
import {isValidClassicAddress} from 'ripple-address-codec';
import {bytes, hex, ISSUER, ORIGIN, utf8} from './common.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validIdentity(input) {
  return typeof input?.buyer === 'string' && isValidClassicAddress(input.buyer) &&
    input.buyer !== ISSUER && typeof input.request === 'string' && uuid.test(input.request);
}
function message({buyer,request,expires,nonce}) {
  return ['CoolBears Testnet reservation','Site '+ORIGIN,'Wallet '+buyer,'Order '+request,
    'Maximum NFT price 10 test XRP','Valid until '+expires,'Nonce '+nonce].join('\n');
}
async function key(secret) {
  return crypto.subtle.importKey('raw', utf8(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
export async function challenge(input, secret, now, xaman=false) {
  const expires = now+240, nonce = hex(crypto.getRandomValues(new Uint8Array(16))).toLowerCase();
  const msg = (xaman?'Xaman OAuth verified\n':'')+message({...input,expires,nonce});
  const tag = hex(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), utf8(msg)))).toLowerCase();
  return {message:msg,expires,nonce,tag};
}
export async function proof(input, secret, now) {
  const {expires,nonce,tag,publicKey,signature} = input;
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now+240 ||
    !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(tag)) return false;
  if (input.provider==='xaman') {
    return crypto.subtle.verify('HMAC',await key(secret),bytes(tag),utf8('Xaman OAuth verified\n'+message(input)));
  }
  if (!/^(ED|02|03)[A-F0-9]{64}$/i.test(publicKey) || !/^[A-F0-9]{100,150}$/i.test(signature)) return false;
  try {
    const msg = utf8(message(input));
    return await crypto.subtle.verify('HMAC', await key(secret), bytes(tag), msg) &&
      deriveAddress(publicKey) === input.buyer && verify(hex(msg),signature,publicKey);
  } catch { return false; }
}
