import { TransactionInstruction } from '/public-mainnet/modules/60139917f8765411c2c3.mjs';
import { Buffer } from '/public-mainnet/modules/b67364f30402cad4ee1b.mjs';
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '/public-mainnet/modules/930b4fe13e70f913e6a3.mjs';

function fromWeb3JsInstruction(instruction) {
  return {
    keys: instruction.keys.map(accountMeta => ({
      ...accountMeta,
      pubkey: fromWeb3JsPublicKey(accountMeta.pubkey)
    })),
    programId: fromWeb3JsPublicKey(instruction.programId),
    data: new Uint8Array(instruction.data)
  };
}
function toWeb3JsInstruction(instruction) {
  return new TransactionInstruction({
    keys: instruction.keys.map(accountMeta => ({
      ...accountMeta,
      pubkey: toWeb3JsPublicKey(accountMeta.pubkey)
    })),
    programId: toWeb3JsPublicKey(instruction.programId),
    data: Buffer.from(instruction.data)
  });
}

export { fromWeb3JsInstruction, toWeb3JsInstruction };

