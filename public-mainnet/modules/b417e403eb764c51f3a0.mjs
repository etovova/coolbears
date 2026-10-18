import { publicKey, publicKeyBytes } from '/public-mainnet/modules/f00551e78105664b932a.mjs';
import { fromWeb3JsKeypair, toWeb3JsPublicKey, fromWeb3JsPublicKey } from '/public-mainnet/modules/d1a0037470c4e8895e78.mjs';
import { ed25519 } from '/public-mainnet/modules/5795c6dd43df192e91ae.mjs';
import { Keypair, PublicKey } from '/public-mainnet/modules/60139917f8765411c2c3.mjs';

function createWeb3JsEddsa() {
  const generateKeypair = () => fromWeb3JsKeypair(Keypair.generate());
  const createKeypairFromSecretKey = secretKey => fromWeb3JsKeypair(Keypair.fromSecretKey(secretKey));
  const createKeypairFromSeed = seed => fromWeb3JsKeypair(Keypair.fromSeed(seed));
  const isOnCurve = input => PublicKey.isOnCurve(toWeb3JsPublicKey(publicKey(input)));
  const findPda = (programId, seeds) => {
    const [key, bump] = PublicKey.findProgramAddressSync(seeds, toWeb3JsPublicKey(publicKey(programId)));
    return [fromWeb3JsPublicKey(key), bump];
  };
  const sign = (message, keypair) => ed25519.sign(message, keypair.secretKey.slice(0, 32));
  const verify = (message, signature, publicKey) => ed25519.verify(signature, message, publicKeyBytes(publicKey));
  return {
    generateKeypair,
    createKeypairFromSecretKey,
    createKeypairFromSeed,
    isOnCurve,
    findPda,
    sign,
    verify
  };
}

export { createWeb3JsEddsa };

