import { Buffer } from '/public-mainnet/modules/b67364f30402cad4ee1b.mjs';
import { Encoder } from "/public-mainnet/modules/d80066a292cc5679a215.mjs";
/**
 * It encodes `value` in the MessagePack format and
 * returns a byte buffer.
 *
 * The returned buffer is a slice of a larger `ArrayBuffer`, so you have to use its `#byteOffset` and `#byteLength` in order to convert it to another typed arrays including NodeJS `Buffer`.
 */
export function encode(value, options) {
    const encoder = new Encoder(options);
    return encoder.encodeSharedRef(value);
}
