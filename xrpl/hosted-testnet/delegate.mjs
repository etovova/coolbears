import {deriveAddress, verify} from 'ripple-keypairs';
import {encodeForSigning} from 'ripple-binary-codec';
import {assert, bytes, hex, ISSUER} from './common.mjs';

export function signingFields(type, publicKey) {
  assert(/^ED[A-F0-9]{64}$/.test(publicKey), 'Invalid Testnet delegate public key');
  const delegate = deriveAddress(publicKey);
  assert(delegate !== ISSUER, 'The signer must be a separate Testnet account');
  if (type === 'NFTokenCancelOffer') return {Account:delegate, SigningPubKey:publicKey};
  assert(type === 'NFTokenMint' || type === 'NFTokenCreateOffer', 'Unsupported order operation');
  return {Account:ISSUER, Delegate:delegate, SigningPubKey:publicKey};
}

export async function signOrder(draft, privateKey) {
  const key = await crypto.subtle.importKey('pkcs8', bytes(privateKey), 'Ed25519', false, ['sign']);
  const message = encodeForSigning(draft);
  const signature = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes(message))));
  assert(verify(message,signature,draft.SigningPubKey), 'Testnet delegate key mismatch');
  return {...draft, TxnSignature:signature};
}
