import { PublicKey } from '/public-mainnet/modules/60139917f8765411c2c3.mjs';

function fromWeb3JsPublicKey(publicKey) {
  return publicKey.toBase58();
}
function toWeb3JsPublicKey(publicKey) {
  return new PublicKey(publicKey);
}

export { fromWeb3JsPublicKey, toWeb3JsPublicKey };

