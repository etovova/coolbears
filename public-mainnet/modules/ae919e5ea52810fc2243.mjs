import { publicKeyBytes } from '/public-mainnet/modules/f00551e78105664b932a.mjs';
import { Keypair } from '/public-mainnet/modules/60139917f8765411c2c3.mjs';
import { fromWeb3JsPublicKey } from '/public-mainnet/modules/930b4fe13e70f913e6a3.mjs';

function fromWeb3JsKeypair(keypair) {
  return {
    publicKey: fromWeb3JsPublicKey(keypair.publicKey),
    secretKey: keypair.secretKey
  };
}
function toWeb3JsKeypair(keypair) {
  return new Keypair({
    publicKey: publicKeyBytes(keypair.publicKey),
    secretKey: keypair.secretKey
  });
}

export { fromWeb3JsKeypair, toWeb3JsKeypair };

